import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// ── List revisions (optionally by orderId) ───────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, status } = req.query as any;
    const where: any = {};
    if (orderId) where.orderId = orderId;
    if (status) where.status = status;

    const revisions = await prisma.orderRevision.findMany({
      where,
      include: { order: { select: { orderNumber: true, customerId: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ revisions });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Create revision request ──────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, fieldChanged, oldValue, newValue, reason } = req.body;
    if (!orderId || !fieldChanged || !reason) {
      return res.status(400).json({ error: 'orderId, fieldChanged, and reason are required' });
    }

    const order = await prisma.customerOrder.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Get next revision number for this order
    const lastRevision = await prisma.orderRevision.findFirst({
      where: { orderId },
      orderBy: { revisionNumber: 'desc' },
    });
    const revisionNumber = (lastRevision?.revisionNumber || 0) + 1;

    // Auto-detect old value if not provided
    const actualOldValue = oldValue || String((order as any)[fieldChanged] ?? '');

    const revision = await prisma.orderRevision.create({
      data: {
        orderId,
        revisionNumber,
        fieldChanged,
        oldValue: actualOldValue,
        newValue: String(newValue),
        reason,
        changedBy: req.user!.id,
      },
      include: { order: { select: { orderNumber: true } } },
    });

    return res.status(201).json(revision);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Approve revision ─────────────────────────────────────────
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const revision = await prisma.orderRevision.findUnique({ where: { id: req.params.id } });
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    if (revision.status !== 'pending') return res.status(400).json({ error: 'Revision is not pending' });

    // Apply the change to the order
    const updateData: any = {};
    const field = revision.fieldChanged;
    // Handle numeric fields
    if (['ratePerTon', 'quantity', 'baseRate', 'adjustedRate'].includes(field)) {
      updateData[field] = Number(revision.newValue);
      // If ratePerTon changed, also update adjustedRate
      if (field === 'ratePerTon') {
        updateData.adjustedRate = Number(revision.newValue);
      }
      // If quantity changed, recalculate remainingQty
      if (field === 'quantity') {
        const order = await prisma.customerOrder.findUnique({ where: { id: revision.orderId } });
        if (order) {
          updateData.remainingQty = Number(revision.newValue) - (order.totalDelivered || 0);
        }
      }
    } else {
      updateData[field] = revision.newValue;
    }

    await prisma.$transaction([
      prisma.orderRevision.update({
        where: { id: req.params.id },
        data: { status: 'approved', approvedBy: req.user!.id, approvedAt: new Date() },
      }),
      prisma.customerOrder.update({
        where: { id: revision.orderId },
        data: updateData,
      }),
    ]);

    const updated = await prisma.orderRevision.findUnique({
      where: { id: req.params.id },
      include: { order: { select: { orderNumber: true } } },
    });
    return res.json(updated);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Reject revision ──────────────────────────────────────────
router.put('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const revision = await prisma.orderRevision.findUnique({ where: { id: req.params.id } });
    if (!revision) return res.status(404).json({ error: 'Revision not found' });
    if (revision.status !== 'pending') return res.status(400).json({ error: 'Revision is not pending' });

    const updated = await prisma.orderRevision.update({
      where: { id: req.params.id },
      data: { status: 'rejected' },
      include: { order: { select: { orderNumber: true } } },
    });
    return res.json(updated);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
