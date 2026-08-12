import prisma from './prisma';

// ─── Notification Levels & Categories ──────────────────────────────────────
export type NotificationLevel = 'critical' | 'urgent' | 'warning' | 'info';
export type NotificationCategory =
  | 'compliance' | 'maintenance' | 'trip' | 'order'
  | 'breakdown' | 'inventory' | 'payroll' | 'system';

// ─── Default role → notification rules ─────────────────────────────────────
// Each role gets specific levels and categories relevant to their job
export const DEFAULT_ROLE_RULES: Record<string, { levels: NotificationLevel[]; categories: NotificationCategory[] }> = {
  owner: {
    levels: ['critical', 'urgent', 'warning', 'info'],
    categories: ['compliance', 'maintenance', 'trip', 'order', 'breakdown', 'inventory', 'payroll', 'system'],
  },
  admin: {
    levels: ['critical', 'urgent', 'warning', 'info'],
    categories: ['compliance', 'maintenance', 'trip', 'order', 'breakdown', 'inventory', 'payroll', 'system'],
  },
  dispatcher: {
    levels: ['critical', 'urgent', 'warning', 'info'],
    categories: ['trip', 'order', 'breakdown', 'compliance'],
  },
  driver: {
    levels: ['info'],
    categories: ['trip'],
  },
  technical_manager: {
    levels: ['critical', 'urgent', 'warning'],
    categories: ['breakdown', 'maintenance', 'compliance', 'inventory'],
  },
  store_manager: {
    levels: ['urgent', 'warning', 'info'],
    categories: ['inventory', 'maintenance'],
  },
  cashier: {
    levels: ['info', 'warning'],
    categories: ['trip', 'payroll'],
  },
  hr: {
    levels: ['info', 'warning'],
    categories: ['payroll', 'system'],
  },
  customer: {
    levels: ['info'],
    categories: ['order', 'trip'],
  },
};

const LEVEL_EMOJI: Record<NotificationLevel, string> = {
  critical: '\u{1F534}',
  urgent:   '\u{1F7E0}',
  warning:  '\u{1F7E1}',
  info:     '\u{1F535}',
};

const LEVEL_LABEL: Record<NotificationLevel, string> = {
  critical: 'CRITICAL',
  urgent:   'URGENT',
  warning:  'WARNING',
  info:     'INFO',
};

const CATEGORY_EMOJI: Record<NotificationCategory, string> = {
  compliance:   '\u{1F6E1}',
  maintenance:  '\u{1F527}',
  trip:         '\u{1F69A}',
  order:        '\u{1F4CB}',
  breakdown:    '\u{26A0}',
  inventory:    '\u{1F4E6}',
  payroll:      '\u{1F4B3}',
  system:       '\u{2699}',
};

// ─── Send message via Telegram Bot API ─────────────────────────────────────
async function sendTelegramMessage(botToken: string, chatId: string, text: string): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await resp.json() as any;
    return data.ok === true;
  } catch (err) {
    console.error('Telegram send error:', err);
    return false;
  }
}

// ─── Format notification message ───────────────────────────────────────────
function formatMessage(
  level: NotificationLevel,
  category: NotificationCategory,
  title: string,
  message: string,
): string {
  const emoji = LEVEL_EMOJI[level];
  const catEmoji = CATEGORY_EMOJI[category] || '';
  const label = LEVEL_LABEL[level];
  const lines = [
    `${emoji} <b>${label}</b> ${catEmoji} <i>${category.toUpperCase()}</i>`,
    '',
    `<b>${title}</b>`,
    message,
    '',
    `<code>Wonde Transport ERP</code>`,
  ];
  return lines.join('\n');
}

// ─── Main notification function (role-based) ──────────────────────────────
export async function sendNotification(
  level: NotificationLevel,
  category: NotificationCategory,
  title: string,
  message: string,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;

  try {
    // Get active config
    const config = await prisma.telegramConfig.findFirst({ where: { isActive: true } });
    if (!config) return { sent: 0, failed: 0 };

    // Parse role rules (custom overrides or defaults)
    const roleRules: Record<string, { levels: string[]; categories: string[] }> =
      config.roleRules ? JSON.parse(config.roleRules) : DEFAULT_ROLE_RULES;

    // Find all users who have a telegramChatId set
    const users = await prisma.user.findMany({
      where: { telegramChatId: { not: null }, isActive: true },
      select: { id: true, name: true, role: true, telegramChatId: true },
    });

    const formattedMsg = formatMessage(level, category, title, message);
    const alreadySent = new Set<string>(); // avoid duplicate sends

    for (const user of users) {
      if (!user.telegramChatId) continue;
      if (alreadySent.has(user.telegramChatId)) continue;

      const rules = roleRules[user.role] || DEFAULT_ROLE_RULES[user.role];
      if (!rules) continue;

      // Check if this user's role should receive this level + category
      if (!rules.levels.includes(level)) continue;
      if (!rules.categories.includes(category)) continue;

      const success = await sendTelegramMessage(config.botToken, user.telegramChatId, formattedMsg);
      alreadySent.add(user.telegramChatId);

      // Log it
      await prisma.telegramLog.create({
        data: {
          level,
          category,
          title,
          message,
          chatId: user.telegramChatId,
          success,
          errorMessage: success ? null : 'Failed to deliver message',
        },
      });

      if (success) sent++;
      else failed++;
    }

    // Also send to legacy manual chat targets (if any configured)
    if (config.chatIds) {
      try {
        const manualTargets = JSON.parse(config.chatIds) as Array<{ chatId: string; label: string; levels: string[] }>;
        for (const target of manualTargets) {
          if (!target.chatId || alreadySent.has(target.chatId)) continue;
          if (!target.levels.includes(level)) continue;

          const success = await sendTelegramMessage(config.botToken, target.chatId, formattedMsg);
          alreadySent.add(target.chatId);

          await prisma.telegramLog.create({
            data: { level, category, title, message, chatId: target.chatId, success,
              errorMessage: success ? null : 'Failed to deliver' },
          });

          if (success) sent++;
          else failed++;
        }
      } catch {}
    }
  } catch (err: any) {
    console.error('sendNotification error:', err.message);
  }

  return { sent, failed };
}

// ─── Test connection ──────────────────────────────────────────────────────
export async function testTelegramConnection(botToken: string, chatId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const text = [
      '\u{2705} <b>Wonde Transport ERP</b>',
      '',
      'Telegram notification connection test successful!',
      '',
      'You will receive notifications at these levels:',
      `${LEVEL_EMOJI.critical} Critical - System failures, expired compliance`,
      `${LEVEL_EMOJI.urgent} Urgent - Breakdowns, overdue items`,
      `${LEVEL_EMOJI.warning} Warning - Upcoming deadlines`,
      `${LEVEL_EMOJI.info} Info - Status updates, daily summaries`,
    ].join('\n');

    const success = await sendTelegramMessage(botToken, chatId, text);
    if (success) return { ok: true };
    return { ok: false, error: 'Message failed to send. Check bot token and chat ID.' };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ─── Get bot info ─────────────────────────────────────────────────────────
export async function getBotInfo(botToken: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const data = await resp.json() as any;
    if (data.ok) return { ok: true, botName: data.result.first_name };
    return { ok: false, error: data.description || 'Invalid bot token' };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

// ─── Compliance check notification helper ──────────────────────────────────
export async function notifyComplianceAlerts(): Promise<void> {
  try {
    const now = new Date();
    const in7d = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const in30d = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      select: { plateNumber: true, insuranceExpiry: true, inspectionExpiry: true, permitExpiry: true },
    });

    const criticalItems: string[] = [];
    const urgentItems: string[] = [];
    const warningItems: string[] = [];

    for (const v of vehicles) {
      const checks = [
        { name: 'Insurance', date: v.insuranceExpiry },
        { name: 'Inspection', date: v.inspectionExpiry },
        { name: 'Permit', date: v.permitExpiry },
      ];
      for (const chk of checks) {
        if (!chk.date) continue;
        if (chk.date < now) {
          criticalItems.push(`${v.plateNumber}: ${chk.name} EXPIRED`);
        } else if (chk.date < in7d) {
          urgentItems.push(`${v.plateNumber}: ${chk.name} expires in <7 days`);
        } else if (chk.date < in30d) {
          warningItems.push(`${v.plateNumber}: ${chk.name} expires in <30 days`);
        }
      }
    }

    if (criticalItems.length > 0) {
      await sendNotification('critical', 'compliance',
        `${criticalItems.length} Expired Compliance Items`,
        criticalItems.join('\n'));
    }
    if (urgentItems.length > 0) {
      await sendNotification('urgent', 'compliance',
        `${urgentItems.length} Compliance Items Expiring Soon`,
        urgentItems.join('\n'));
    }
    if (warningItems.length > 0) {
      await sendNotification('warning', 'compliance',
        `${warningItems.length} Upcoming Compliance Deadlines`,
        warningItems.join('\n'));
    }
  } catch (err: any) {
    console.error('Compliance notification error:', err.message);
  }
}

// ─── Low inventory alert ───────────────────────────────────────────────────
export async function notifyLowInventory(): Promise<void> {
  try {
    const allItems = await prisma.inventory.findMany();
    const lowItems = allItems.filter(i => i.quantityInStock <= i.minimumStock && i.minimumStock > 0);

    if (lowItems.length > 0) {
      const details = lowItems.map(i => `${i.partName}: ${i.quantityInStock}/${i.minimumStock} ${i.unit}`).join('\n');
      await sendNotification('warning', 'inventory',
        `${lowItems.length} Items Below Minimum Stock`,
        details);
    }
  } catch (err: any) {
    console.error('Inventory notification error:', err.message);
  }
}
