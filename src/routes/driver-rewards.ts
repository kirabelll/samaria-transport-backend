import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// Rules CRUD
router.get('/rules', async (req: AuthRequest, res: Response) => {
  try {
    const rules = await prisma.rewardPenaltyRule.findMany({ orderBy: { minScore: 'desc' } });
    return res.json({ rules });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/rules', async (req: AuthRequest, res: Response) => {
  try {
    const { name, type, trigger, minScore, maxScore, amount, description } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name, type required' });
    const rule = await prisma.rewardPenaltyRule.create({ data: {
      name, type, trigger: trigger || 'score', minScore: minScore ? Number(minScore) : null,
      maxScore: maxScore ? Number(maxScore) : null, amount: Number(amount) || 0, description,
    }});
    return res.status(201).json({ rule });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/rules/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['name', 'type', 'trigger', 'description', 'isActive'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['minScore', 'maxScore', 'amount'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    const rule = await prisma.rewardPenaltyRule.update({ where: { id: req.params.id }, data });
    return res.json({ rule });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// List rewards/penalties
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId, month, year, status } = req.query as any;
    const where: any = {};
    if (driverId) where.driverId = driverId;
    if (month) where.month = Number(month);
    if (year) where.year = Number(year);
    if (status) where.status = status;
    const items = await prisma.driverRewardPenalty.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { driver: { select: { firstName: true, lastName: true } } },
    });
    return res.json({ items: items.map((i: any) => ({
      ...i, driverName: `${i.driver.firstName} ${i.driver.lastName}`,
    }))});
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Auto-generate from scores
router.post('/generate', async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.body;
    const m = month || new Date().getMonth() + 1;
    const y = year || new Date().getFullYear();

    const scores = await prisma.driverScore.findMany({
      where: { month: m, year: y },
      include: { driver: { select: { firstName: true, lastName: true } } },
    });
    const rules = await prisma.rewardPenaltyRule.findMany({ where: { isActive: true } });
    const generated: any[] = [];

    for (const score of scores) {
      for (const rule of rules as any[]) {
        const matches = (rule.minScore === null || score.totalScore >= rule.minScore) &&
                       (rule.maxScore === null || score.totalScore <= rule.maxScore);
        if (!matches) continue;

        // Check if already exists
        const existing = await prisma.driverRewardPenalty.findFirst({
          where: { driverId: score.driverId, ruleId: rule.id, month: m, year: y },
        });
        if (existing) continue;

        const entry = await prisma.driverRewardPenalty.create({ data: {
          driverId: score.driverId, ruleId: rule.id, type: rule.type,
          amount: rule.amount, reason: `${rule.name}: Score ${score.totalScore}`,
          month: m, year: y, status: 'pending',
        }});
        generated.push(entry);
      }
    }
    return res.json({ generated, count: generated.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Manual entry
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId, type, amount, reason, month, year } = req.body;
    if (!driverId || !type || !amount) return res.status(400).json({ error: 'driverId, type, amount required' });
    const entry = await prisma.driverRewardPenalty.create({ data: {
      driverId, type, amount: Number(amount), reason,
      month: month || new Date().getMonth() + 1,
      year: year || new Date().getFullYear(), status: 'pending',
    }});
    return res.status(201).json({ entry });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Approve
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const entry = await prisma.driverRewardPenalty.update({
      where: { id: req.params.id }, data: { status: 'approved', approvedBy: req.user?.id },
    });
    return res.json({ entry });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Apply to payroll (mark as applied)
router.put('/:id/apply', async (req: AuthRequest, res: Response) => {
  try {
    const entry = await prisma.driverRewardPenalty.update({
      where: { id: req.params.id }, data: { status: 'applied' },
    });
    return res.json({ entry });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
