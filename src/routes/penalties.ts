import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// ── List penalties ───────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, tripId, status, type } = req.query as any;
    const where: any = {};
    if (orderId) where.orderId = orderId;
    if (tripId) where.tripId = tripId;
    if (status) where.status = status;
    if (type) where.type = type;

    const penalties = await prisma.orderPenalty.findMany({
      where,
      include: {
        order: { select: { orderNumber: true, customerId: true } },
        trip: { select: { tripNumber: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ penalties });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Create penalty ───────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, tripId, type, description, quantityAffected, rateApplied, amount } = req.body;
    if (!orderId || !type || !amount) {
      return res.status(400).json({ error: 'orderId, type, and amount are required' });
    }

    const order = await prisma.customerOrder.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const penalty = await prisma.orderPenalty.create({
      data: {
        orderId,
        tripId: tripId || null,
        type,
        description,
        quantityAffected: quantityAffected ? Number(quantityAffected) : null,
        rateApplied: rateApplied ? Number(rateApplied) : null,
        amount: Number(amount),
      },
      include: {
        order: { select: { orderNumber: true } },
        trip: { select: { tripNumber: true } },
      },
    });
    return res.status(201).json(penalty);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Approve penalty ──────────────────────────────────────────
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const penalty = await prisma.orderPenalty.findUnique({ where: { id: req.params.id } });
    if (!penalty) return res.status(404).json({ error: 'Penalty not found' });
    if (penalty.status !== 'pending') return res.status(400).json({ error: 'Penalty is not pending' });

    const updated = await prisma.orderPenalty.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user!.id, approvedAt: new Date() },
      include: { order: { select: { orderNumber: true } }, trip: { select: { tripNumber: true } } },
    });
    return res.json(updated);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Apply penalty (mark as applied to settlement) ────────────
router.put('/:id/apply', async (req: AuthRequest, res: Response) => {
  try {
    const penalty = await prisma.orderPenalty.findUnique({ where: { id: req.params.id } });
    if (!penalty) return res.status(404).json({ error: 'Penalty not found' });
    if (penalty.status !== 'approved') return res.status(400).json({ error: 'Penalty must be approved first' });

    const updated = await prisma.orderPenalty.update({
      where: { id: req.params.id },
      data: { status: 'applied' },
      include: { order: { select: { orderNumber: true } }, trip: { select: { tripNumber: true } } },
    });
    return res.json(updated);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Waive penalty ────────────────────────────────────────────
router.put('/:id/waive', async (req: AuthRequest, res: Response) => {
  try {
    const penalty = await prisma.orderPenalty.findUnique({ where: { id: req.params.id } });
    if (!penalty) return res.status(404).json({ error: 'Penalty not found' });
    if (!['pending', 'approved'].includes(penalty.status)) return res.status(400).json({ error: 'Penalty cannot be waived in current status' });

    const { reason } = req.body;
    const updated = await prisma.orderPenalty.update({
      where: { id: req.params.id },
      data: { status: 'waived', waivedBy: req.user!.id, waivedReason: reason, waivedAt: new Date() },
      include: { order: { select: { orderNumber: true } }, trip: { select: { tripNumber: true } } },
    });
    return res.json(updated);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Summary by order ─────────────────────────────────────────
router.get('/summary/:orderId', async (req: AuthRequest, res: Response) => {
  try {
    const penalties = await prisma.orderPenalty.findMany({
      where: { orderId: req.params.orderId },
    });
    const byType: Record<string, { count: number; totalAmount: number }> = {};
    for (const p of penalties) {
      if (!byType[p.type]) byType[p.type] = { count: 0, totalAmount: 0 };
      byType[p.type].count++;
      byType[p.type].totalAmount += p.amount;
    }
    return res.json({
      total: penalties.length,
      totalAmount: penalties.reduce((s, p) => s + p.amount, 0),
      pending: penalties.filter(p => p.status === 'pending').length,
      approved: penalties.filter(p => p.status === 'approved').length,
      applied: penalties.filter(p => p.status === 'applied').length,
      waived: penalties.filter(p => p.status === 'waived').length,
      byType,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
