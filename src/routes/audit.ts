import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// List audit logs
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { entityType, action, userId, from, to, limit } = req.query;
    const where: any = {};
    if (entityType) where.entityType = entityType;
    if (action) where.action = action;
    if (userId) where.userId = userId;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from as string);
      if (to) where.createdAt.lte = new Date(to as string);
    }

    const logs = await prisma.auditLog.findMany({
      where, orderBy: { createdAt: 'desc' }, take: Number(limit) || 100,
      include: { user: { select: { name: true, email: true, role: true } } },
    });
    const total = await prisma.auditLog.count({ where });

    return res.json({ logs, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Get audit logs for specific entity
router.get('/entity/:type/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { type, id } = req.params;
    const logs = await prisma.auditLog.findMany({
      where: { entityType: type, entityId: id },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { name: true, email: true } } },
    });
    return res.json({ logs });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Entity types summary
router.get('/summary', async (_req: AuthRequest, res: Response) => {
  try {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startOfWeek = new Date(startOfDay.getTime() - startOfDay.getDay() * 86400000);

    const [todayCount, weekCount, totalCount] = await Promise.all([
      prisma.auditLog.count({ where: { createdAt: { gte: startOfDay } } }),
      prisma.auditLog.count({ where: { createdAt: { gte: startOfWeek } } }),
      prisma.auditLog.count(),
    ]);

    // Group by entityType
    const allLogs = await prisma.auditLog.findMany({ select: { entityType: true, action: true } });
    const byEntity: any = {};
    const byAction: any = {};
    for (const l of allLogs) {
      byEntity[l.entityType] = (byEntity[l.entityType] || 0) + 1;
      byAction[l.action] = (byAction[l.action] || 0) + 1;
    }

    return res.json({ todayCount, weekCount, totalCount, byEntity, byAction });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
