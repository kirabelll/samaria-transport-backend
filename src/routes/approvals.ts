import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { executeApproval } from '../utils/approval';
import { sendNotification } from '../utils/telegram';
import { generateApprovalRequestNumber } from '../utils/sequence-generator';
const router = Router();
router.use(authenticate);

// List approval requests
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, type, priority, page = '1', limit = '30' } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (type) where.type = type;
    if (priority) where.priority = priority;
    const skip = (Number(page) - 1) * Number(limit);
    const [requests, total] = await Promise.all([
      prisma.approvalRequest.findMany({
        where, skip, take: Number(limit), orderBy: { createdAt: 'desc' },
      }),
      prisma.approvalRequest.count({ where }),
    ]);
    return res.json({ requests, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Pending count
router.get('/pending-count', async (req: AuthRequest, res: Response) => {
  try {
    const count = await prisma.approvalRequest.count({ where: { status: 'pending' } });
    return res.json({ count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Get single approval request
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } });
    if (!request) return res.status(404).json({ error: 'Not found' });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Create approval request manually
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { type, entityType, entityId, description, amount, currentData, proposedData, priority } = req.body;
    if (!type || !entityType || !entityId || !description)
      return res.status(400).json({ error: 'type, entityType, entityId, description required' });
    const requestNumber = await generateApprovalRequestNumber();

    const request = await prisma.approvalRequest.create({
      data: {
        requestNumber, type, entityType, entityId, description,
        amount: amount ? Number(amount) : null,
        currentData: currentData ? JSON.stringify(currentData) : null,
        proposedData: proposedData ? JSON.stringify(proposedData) : null,
        priority: priority || 'normal',
        requestedBy: req.user?.id,
        status: 'pending',
      },
    });
    return res.status(201).json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Approve request
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } }) as any;
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    const updated = await prisma.approvalRequest.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user?.id, approvedAt: new Date() },
    });

    // Execute the underlying action
    const result = await executeApproval(updated);

    // Audit log
    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'approval_approved', entityType: 'approval_request',
      entityId: request.id, details: JSON.stringify({ requestNumber: request.requestNumber, type: request.type, result }),
    }});

    // Telegram: notify approval approved
    sendNotification('info', 'system',
      `✅ Approved: ${request.requestNumber}`,
      `${request.type.replace(/_/g, ' ').toUpperCase()} approved.\n${request.description}\nAmount: ${request.amount ? 'ETB ' + Number(request.amount).toLocaleString() : 'N/A'}`
    ).catch(() => {});

    return res.json({ request: updated, executionResult: result });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Reject request
router.put('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    const request = await prisma.approvalRequest.findUnique({ where: { id: req.params.id } }) as any;
    if (!request) return res.status(404).json({ error: 'Not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: 'Request is not pending' });

    const updated = await prisma.approvalRequest.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectedBy: req.user?.id, rejectedAt: new Date(), rejectionReason: reason || null },
    });

    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'approval_rejected', entityType: 'approval_request',
      entityId: request.id, details: JSON.stringify({ requestNumber: request.requestNumber, type: request.type, reason }),
    }});

    // Telegram: notify approval rejected
    sendNotification('warning', 'system',
      `❌ Rejected: ${request.requestNumber}`,
      `${request.type.replace(/_/g, ' ').toUpperCase()} rejected.\n${request.description}\nReason: ${reason || 'No reason given'}`
    ).catch(() => {});

    return res.json({ request: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── APPROVAL RULES ──────────────────────────────────────────

// List rules
router.get('/rules/list', async (req: AuthRequest, res: Response) => {
  try {
    const rules = await prisma.approvalRule.findMany({ orderBy: { type: 'asc' } });
    return res.json({ rules });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Create/update rule
router.post('/rules', async (req: AuthRequest, res: Response) => {
  try {
    const { type, requiredRole, thresholdAmount, description, isActive } = req.body;
    if (!type) return res.status(400).json({ error: 'type is required' });

    const rule = await prisma.approvalRule.upsert({
      where: { type },
      update: {
        ...(requiredRole !== undefined && { requiredRole }),
        ...(thresholdAmount !== undefined && { thresholdAmount: thresholdAmount ? Number(thresholdAmount) : null }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
      },
      create: {
        type,
        requiredRole: requiredRole || 'admin',
        thresholdAmount: thresholdAmount ? Number(thresholdAmount) : null,
        description: description || type.replace(/_/g, ' '),
        isActive: isActive !== undefined ? isActive : true,
      },
    });
    return res.json({ rule });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Update rule
router.put('/rules/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { requiredRole, thresholdAmount, description, isActive } = req.body;
    const rule = await prisma.approvalRule.update({
      where: { id: req.params.id },
      data: {
        ...(requiredRole !== undefined && { requiredRole }),
        ...(thresholdAmount !== undefined && { thresholdAmount: thresholdAmount ? Number(thresholdAmount) : null }),
        ...(description !== undefined && { description }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    return res.json({ rule });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Seed default rules
router.post('/rules/seed', async (req: AuthRequest, res: Response) => {
  try {
    const defaults = [
      { type: 'rate_adjustment', requiredRole: 'admin', description: 'Rate changes on orders', isActive: true },
      { type: 'penalty_waiver', requiredRole: 'admin', description: 'Waive order penalties', isActive: true },
      { type: 'vehicle_swap', requiredRole: 'dispatcher', description: 'Vehicle swap on active trips', isActive: false },
      { type: 'large_advance', requiredRole: 'admin', thresholdAmount: 5000, description: 'Driver advances above threshold', isActive: true },
      { type: 'cash_transfer', requiredRole: 'admin', description: 'Cash transfers between cashiers', isActive: false },
      { type: 'invoice_cancellation', requiredRole: 'owner', description: 'Cancel issued invoices', isActive: true },
      { type: 'settlement_override', requiredRole: 'admin', description: 'Override settlement amounts', isActive: true },
      { type: 'compliance_unlock', requiredRole: 'admin', description: 'Unlock compliance-locked vehicles', isActive: false },
    ];

    const results = [];
    for (const d of defaults) {
      const rule = await prisma.approvalRule.upsert({
        where: { type: d.type },
        update: {},
        create: d,
      });
      results.push(rule);
    }
    return res.json({ rules: results, count: results.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
