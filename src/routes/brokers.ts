import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

// GET /brokers
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.status = status;
    const brokers = await prisma.broker.findMany({
      where, orderBy: { name: 'asc' },
      include: { _count: { select: { commissions: true } } }
    });
    return res.json({ brokers });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// POST /brokers
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, phone, email, commissionType, defaultRate, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const broker = await prisma.broker.create({
      data: {
        name, phone, email,
        commissionType: commissionType || 'percentage',
        defaultRate: Number(defaultRate) || 0,
        notes
      }
    });
    return res.status(201).json({ broker });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /brokers/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['name','phone','email','commissionType','notes','status'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    if (req.body.defaultRate !== undefined) data.defaultRate = Number(req.body.defaultRate);
    const broker = await prisma.broker.update({ where: { id: req.params.id }, data });
    return res.json({ broker });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// COMMISSIONS
// ════════════════════════════════════════════════════════════════════════════
router.get('/commissions', async (req: AuthRequest, res: Response) => {
  try {
    const { brokerId, status } = req.query as Record<string, string>;
    const where: any = {};
    if (brokerId) where.brokerId = brokerId;
    if (status) where.status = status;
    const commissions = await prisma.brokerCommission.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { broker: { select: { name: true } } }
    });
    return res.json({ commissions });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/commissions', async (req: AuthRequest, res: Response) => {
  try {
    const { brokerId, tripId, orderId, commissionType, rate, amount, tripRevenue, notes } = req.body;
    if (!brokerId || !amount) return res.status(400).json({ error: 'brokerId and amount required' });

    const commission = await prisma.brokerCommission.create({
      data: {
        brokerId, tripId, orderId,
        commissionType: commissionType || 'fixed',
        rate: rate ? Number(rate) : null,
        amount: Number(amount),
        tripRevenue: tripRevenue ? Number(tripRevenue) : null,
        notes, status: 'unpaid'
      }
    });

    // Update broker balance
    await prisma.broker.update({
      where: { id: brokerId },
      data: { totalEarned: { increment: Number(amount) }, balance: { increment: Number(amount) } }
    });

    return res.status(201).json({ commission });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/commissions/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const commission = await prisma.brokerCommission.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user?.id, approvedAt: new Date() }
    });
    return res.json({ commission });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/commissions/:id/pay', async (req: AuthRequest, res: Response) => {
  try {
    const { paymentRef } = req.body;
    const commission = await prisma.brokerCommission.findUnique({ where: { id: req.params.id } });
    if (!commission) return res.status(404).json({ error: 'Not found' });

    await prisma.brokerCommission.update({
      where: { id: req.params.id },
      data: { status: 'paid', paidAt: new Date(), paymentRef }
    });

    await prisma.broker.update({
      where: { id: commission.brokerId },
      data: { totalPaid: { increment: commission.amount }, balance: { decrement: commission.amount } }
    });

    return res.json({ message: 'Commission paid' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Summary
router.get('/summary', async (req: AuthRequest, res: Response) => {
  try {
    const brokers = await prisma.broker.findMany({
      include: {
        commissions: { select: { amount: true, status: true } }
      }
    });
    const summary = brokers.map((b: any) => ({
      id: b.id, name: b.name, phone: b.phone, status: b.status,
      totalEarned: b.totalEarned, totalPaid: b.totalPaid, balance: b.balance,
      unpaidCount: b.commissions.filter((c: any) => c.status === 'unpaid').length,
      totalCommissions: b.commissions.length
    }));
    return res.json({
      brokers: summary,
      totalUnpaid: summary.reduce((s: number, b: any) => s + b.balance, 0)
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
