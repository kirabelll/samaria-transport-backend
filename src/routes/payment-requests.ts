import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// GET /stats - Summary stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const [pending, approved, paid] = await Promise.all([
      prisma.paymentRequest.aggregate({ where: { status: 'submitted' }, _sum: { amount: true }, _count: true }),
      prisma.paymentRequest.aggregate({ where: { status: 'approved' }, _sum: { amount: true }, _count: true }),
      prisma.paymentRequest.aggregate({ where: { status: 'paid' }, _sum: { amount: true, paidAmount: true }, _count: true }),
    ]);
    return res.json({
      pending: { count: pending._count, totalAmount: pending._sum.amount || 0 },
      approved: { count: approved._count, totalAmount: approved._sum.amount || 0 },
      paid: { count: paid._count, totalAmount: paid._sum.paidAmount || 0 },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET / - List payment requests with filters
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, department, referenceType, page = '1', limit = '20' } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (department) where.department = department;
    if (referenceType) where.referenceType = referenceType;
    const skip = (Number(page) - 1) * Number(limit);
    const [requests, total] = await Promise.all([
      prisma.paymentRequest.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' } }),
      prisma.paymentRequest.count({ where }),
    ]);
    return res.json({ requests, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// POST / - Create payment request (always starts as draft)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      paymentType, payee, amount, description, referenceType, referenceId,
      department, dueDate, supportingDoc,
      payeeBank, payeeAccountHolder, payeeAccountNumber, paymentMethod, vehicleId,
    } = req.body;
    if (!paymentType || !payee || !amount || !description || !referenceType || !referenceId) {
      return res.status(400).json({ error: 'paymentType, payee, amount, description, referenceType, referenceId required' });
    }
    const validRefTypes = ['trip', 'work_order', 'po', 'payroll', 'settlement'];
    if (!validRefTypes.includes(referenceType)) {
      return res.status(400).json({ error: `referenceType must be one of: ${validRefTypes.join(', ')}` });
    }

    const year = new Date().getFullYear();
    const lastReq = await prisma.paymentRequest.findFirst({
      where: { requestNumber: { startsWith: `PAY-${year}-` } },
      orderBy: { requestNumber: 'desc' },
    });
    let seq = 1;
    if (lastReq) {
      const lastSeq = parseInt(lastReq.requestNumber.split('-')[2], 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const requestNumber = `PAY-${year}-${String(seq).padStart(6, '0')}`;

    const request = await prisma.paymentRequest.create({
      data: {
        requestNumber,
        paymentType, payee,
        amount: Number(amount),
        description, referenceType, referenceId,
        department: department || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        supportingDoc: supportingDoc || null,
        status: 'draft',
        requestedById: req.user?.id || null,
        payeeBank: payeeBank || null,
        payeeAccountHolder: payeeAccountHolder || null,
        payeeAccountNumber: payeeAccountNumber || null,
        paymentMethod: paymentMethod || null,
        vehicleId: vehicleId || null,
      } as any,
    });
    return res.status(201).json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id - Edit a draft payment request (creator only, draft only)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft payment requests can be edited' });
    }
    if (existing.requestedById && existing.requestedById !== req.user?.id
        && req.user?.role !== 'owner' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only the creator or an admin can edit this draft' });
    }
    const {
      paymentType, payee, amount, description, referenceType, referenceId,
      department, dueDate, supportingDoc,
      payeeBank, payeeAccountHolder, payeeAccountNumber, paymentMethod, vehicleId,
    } = req.body as any;
    const data: any = {};
    if (paymentType !== undefined) data.paymentType = paymentType;
    if (payee !== undefined) data.payee = payee;
    if (amount !== undefined) data.amount = Number(amount);
    if (description !== undefined) data.description = description;
    if (referenceType !== undefined) data.referenceType = referenceType;
    if (referenceId !== undefined) data.referenceId = referenceId;
    if (department !== undefined) data.department = department || null;
    if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
    if (supportingDoc !== undefined) data.supportingDoc = supportingDoc || null;
    if (payeeBank !== undefined) data.payeeBank = payeeBank || null;
    if (payeeAccountHolder !== undefined) data.payeeAccountHolder = payeeAccountHolder || null;
    if (payeeAccountNumber !== undefined) data.payeeAccountNumber = payeeAccountNumber || null;
    if (paymentMethod !== undefined) data.paymentMethod = paymentMethod || null;
    if (vehicleId !== undefined) data.vehicleId = vehicleId || null;
    const request = await prisma.paymentRequest.update({ where: { id: req.params.id }, data });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// DELETE /:id - Delete a draft payment request (creator only, draft only)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft payment requests can be deleted' });
    }
    if (existing.requestedById && existing.requestedById !== req.user?.id
        && req.user?.role !== 'owner' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only the creator or an admin can delete this draft' });
    }
    await prisma.paymentRequest.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/submit - Submit a draft request
router.put('/:id/submit', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'draft') return res.status(400).json({ error: 'Only draft requests can be submitted' });

    const request = await prisma.paymentRequest.update({
      where: { id: req.params.id },
      data: { status: 'submitted' },
    });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/approve - Approve a submitted request (owner/admin only)
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user?.role;
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only owner or admin can approve payment requests' });
    }
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'submitted') return res.status(400).json({ error: 'Only submitted requests can be approved' });

    const request = await prisma.paymentRequest.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedById: req.user?.id, approvedAt: new Date() },
    });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/reject - Reject a request with reason
router.put('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });

    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'submitted' && existing.status !== 'approved') {
      return res.status(400).json({ error: 'Only submitted or approved requests can be rejected' });
    }

    const request = await prisma.paymentRequest.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectedById: req.user?.id, rejectedReason: reason },
    });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/pay - Execute payment
router.put('/:id/pay', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return res.status(400).json({ error: 'cashierId required' });

    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'approved') return res.status(400).json({ error: 'Only approved requests can be paid' });

    const cashier = await prisma.cashier.findUnique({ where: { id: cashierId } }) as any;
    if (!cashier) return res.status(404).json({ error: 'Cashier not found' });
    if (cashier.currentBalance < existing.amount) {
      return res.status(400).json({ error: 'Insufficient cashier balance' });
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.cashTransaction.create({
        data: {
          cashierId,
          type: 'out',
          category: existing.paymentType,
          amount: existing.amount,
          referenceId: existing.id,
          referenceType: 'payment_request',
          description: `Payment: ${existing.requestNumber} - ${existing.payee}`,
        },
      });
      await tx.cashier.update({ where: { id: cashierId }, data: { currentBalance: { decrement: existing.amount } } });
      await tx.paymentRequest.update({
        where: { id: req.params.id },
        data: {
          status: 'paid',
          paidAmount: existing.amount,
          paidById: req.user?.id,
          paidAt: new Date(),
          cashTransactionId: null,
        },
      });
    });

    return res.json({ message: 'Payment executed successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
