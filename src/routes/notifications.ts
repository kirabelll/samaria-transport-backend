import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

router.put('/read-all', async (req: AuthRequest, res: Response) => {
  try {
    const result = await prisma.notification.updateMany({ where: { userId: req.user!.id, isRead: false }, data: { isRead: true } });
    return res.json({ updated: result.count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { isRead } = req.query as any;
    const where: any = { userId: req.user!.id };
    if (isRead !== undefined) where.isRead = isRead === 'true';
    const [notifications, unreadCount] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50 }),
      prisma.notification.count({ where: { userId: req.user!.id, isRead: false } }) ]);
    return res.json({ notifications, unreadCount });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/:id/read', async (req: AuthRequest, res: Response) => {
  try {
    const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
    if (!n || n.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
    await prisma.notification.update({ where: { id: req.params.id }, data: { isRead: true } });
    return res.json({ message: 'Marked as read' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;