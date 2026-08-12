import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import {
  sendNotification, testTelegramConnection, getBotInfo,
  notifyComplianceAlerts, notifyLowInventory,
  NotificationLevel, NotificationCategory, DEFAULT_ROLE_RULES,
} from '../utils/telegram';

const router = Router();
router.use(authenticate);

// ─── GET config (bot + role rules) ───────────────────────────────────────────
router.get('/config', async (_req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.telegramConfig.findFirst({ orderBy: { createdAt: 'desc' } });
    if (!config) return res.json({ config: null, defaultRoleRules: DEFAULT_ROLE_RULES });
    const masked = config.botToken.length > 12
      ? config.botToken.slice(0, 5) + '***' + config.botToken.slice(-5)
      : '***';
    const roleRules = config.roleRules ? JSON.parse(config.roleRules) : DEFAULT_ROLE_RULES;
    const manualTargets = config.chatIds ? JSON.parse(config.chatIds) : [];
    return res.json({
      config: {
        id: config.id,
        botToken: masked,
        roleRules,
        manualTargets,
        isActive: config.isActive,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
      },
      defaultRoleRules: DEFAULT_ROLE_RULES,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── SAVE / UPDATE config ────────────────────────────────────────────────────
router.post('/config', async (req: AuthRequest, res: Response) => {
  try {
    const { botToken, roleRules, manualTargets, isActive } = req.body;
    if (!botToken) return res.status(400).json({ error: 'Bot token is required' });

    const botInfo = await getBotInfo(botToken);
    if (!botInfo.ok) return res.status(400).json({ error: `Invalid bot token: ${botInfo.error}` });

    const existing = await prisma.telegramConfig.findFirst();
    let config;
    const data = {
      botToken,
      chatIds: JSON.stringify(manualTargets || []),
      roleRules: JSON.stringify(roleRules || DEFAULT_ROLE_RULES),
      isActive: isActive !== false,
    };
    if (existing) {
      config = await prisma.telegramConfig.update({ where: { id: existing.id }, data });
    } else {
      config = await prisma.telegramConfig.create({ data });
    }

    return res.json({ message: 'Telegram configuration saved', botName: botInfo.botName, config: { id: config.id, isActive: config.isActive } });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── UPDATE role rules only ──────────────────────────────────────────────────
router.put('/config/roles', async (req: AuthRequest, res: Response) => {
  try {
    const { roleRules } = req.body;
    if (!roleRules) return res.status(400).json({ error: 'roleRules required' });
    const config = await prisma.telegramConfig.findFirst();
    if (!config) return res.status(404).json({ error: 'No Telegram config found. Save bot token first.' });
    await prisma.telegramConfig.update({
      where: { id: config.id },
      data: { roleRules: JSON.stringify(roleRules) },
    });
    return res.json({ message: 'Role rules updated' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── TOGGLE active state ─────────────────────────────────────────────────────
router.put('/config/toggle', async (_req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.telegramConfig.findFirst();
    if (!config) return res.status(404).json({ error: 'No Telegram config found' });
    const updated = await prisma.telegramConfig.update({ where: { id: config.id }, data: { isActive: !config.isActive } });
    return res.json({ isActive: updated.isActive });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── GET all users with their telegram link status ───────────────────────────
router.get('/users', async (_req: AuthRequest, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true, role: true, telegramChatId: true },
      orderBy: { role: 'asc' },
    });
    return res.json({ users });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── LINK / UNLINK telegram chatId for a user ────────────────────────────────
router.put('/users/:id/link', async (req: AuthRequest, res: Response) => {
  try {
    const { telegramChatId } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { telegramChatId: telegramChatId || null },
      select: { id: true, name: true, role: true, telegramChatId: true },
    });
    return res.json({ user });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── BULK link telegram chatIds ──────────────────────────────────────────────
router.put('/users/bulk-link', async (req: AuthRequest, res: Response) => {
  try {
    const { links } = req.body; // [{ userId, telegramChatId }]
    if (!Array.isArray(links)) return res.status(400).json({ error: 'links array required' });
    let updated = 0;
    for (const link of links) {
      await prisma.user.update({
        where: { id: link.userId },
        data: { telegramChatId: link.telegramChatId || null },
      });
      updated++;
    }
    return res.json({ updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── TEST connection ─────────────────────────────────────────────────────────
router.post('/test', async (req: AuthRequest, res: Response) => {
  try {
    const { botToken, chatId } = req.body;
    if (!botToken || !chatId) return res.status(400).json({ error: 'botToken and chatId required' });
    const result = await testTelegramConnection(botToken, chatId);
    return res.json(result);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── SEND manual notification ────────────────────────────────────────────────
router.post('/send', async (req: AuthRequest, res: Response) => {
  try {
    const { level, category, title, message } = req.body;
    if (!level || !category || !title || !message) {
      return res.status(400).json({ error: 'level, category, title, and message are required' });
    }
    const result = await sendNotification(level as NotificationLevel, category as NotificationCategory, title, message);
    return res.json(result);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── TRIGGER compliance scan ─────────────────────────────────────────────────
router.post('/scan/compliance', async (_req: AuthRequest, res: Response) => {
  try {
    await notifyComplianceAlerts();
    return res.json({ message: 'Compliance scan notifications sent' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── TRIGGER inventory scan ──────────────────────────────────────────────────
router.post('/scan/inventory', async (_req: AuthRequest, res: Response) => {
  try {
    await notifyLowInventory();
    return res.json({ message: 'Inventory scan notifications sent' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── GET notification logs ───────────────────────────────────────────────────
router.get('/logs', async (req: AuthRequest, res: Response) => {
  try {
    const { level, category, success, limit = '50' } = req.query as any;
    const where: any = {};
    if (level) where.level = level;
    if (category) where.category = category;
    if (success !== undefined) where.success = success === 'true';
    const [logs, total] = await Promise.all([
      prisma.telegramLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: parseInt(limit) }),
      prisma.telegramLog.count({ where }),
    ]);
    const stats = await prisma.telegramLog.groupBy({
      by: ['level'],
      _count: { id: true },
      where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
    });
    return res.json({ logs, total, weeklyStats: stats });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── CLEAR old logs ──────────────────────────────────────────────────────────
router.delete('/logs', async (req: AuthRequest, res: Response) => {
  try {
    const { olderThanDays = 30 } = req.query as any;
    const cutoff = new Date(Date.now() - parseInt(olderThanDays) * 24 * 60 * 60 * 1000);
    const result = await prisma.telegramLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    return res.json({ deleted: result.count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
