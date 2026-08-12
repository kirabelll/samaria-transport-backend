import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// --- Chart of Accounts ---
router.get('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const { category, isActive } = req.query as any;
    const where: any = {};
    if (category) where.category = category;
    if (isActive !== undefined) where.isActive = isActive === 'true';
    const accounts = await prisma.account.findMany({ where, orderBy: { code: 'asc' },
      include: { parent: { select: { code: true, name: true } } } });
    return res.json({ accounts });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/accounts', async (req: AuthRequest, res: Response) => {
  try {
    const { code, name, category, type, parentId, description } = req.body;
    if (!code || !name || !category || !type) return res.status(400).json({ error: 'code, name, category, type required' });
    const account = await prisma.account.create({ data: { code, name, category, type, parentId, description } });
    return res.status(201).json({ account });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/accounts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['code', 'name', 'category', 'type', 'description', 'parentId'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    if (req.body.isActive !== undefined) data.isActive = req.body.isActive;
    const account = await prisma.account.update({ where: { id: req.params.id }, data });
    return res.json({ account });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Seed default chart of accounts
router.post('/seed', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.account.count();
    if (existing > 0) return res.json({ message: 'Accounts already exist', count: existing });

    const defaults = [
      // Assets (1000s)
      { code: '1000', name: 'Assets', category: 'asset', type: 'header' },
      { code: '1100', name: 'Cash and Bank', category: 'asset', type: 'detail' },
      { code: '1110', name: 'Main Cash', category: 'asset', type: 'detail' },
      { code: '1120', name: 'Bank Account', category: 'asset', type: 'detail' },
      { code: '1200', name: 'Accounts Receivable', category: 'asset', type: 'detail' },
      { code: '1300', name: 'Inventory - Spare Parts', category: 'asset', type: 'detail' },
      { code: '1400', name: 'Vehicles (Fixed Assets)', category: 'asset', type: 'detail' },
      { code: '1410', name: 'Accumulated Depreciation', category: 'asset', type: 'detail' },
      // Liabilities (2000s)
      { code: '2000', name: 'Liabilities', category: 'liability', type: 'header' },
      { code: '2100', name: 'Accounts Payable', category: 'liability', type: 'detail' },
      { code: '2200', name: 'Driver Advances Payable', category: 'liability', type: 'detail' },
      { code: '2300', name: 'Rental Owner Payable', category: 'liability', type: 'detail' },
      // Equity (3000s)
      { code: '3000', name: 'Equity', category: 'equity', type: 'header' },
      { code: '3100', name: 'Owner Capital', category: 'equity', type: 'detail' },
      { code: '3200', name: 'Retained Earnings', category: 'equity', type: 'detail' },
      // Revenue (4000s)
      { code: '4000', name: 'Revenue', category: 'revenue', type: 'header' },
      { code: '4100', name: 'Trip Revenue - Cement', category: 'revenue', type: 'detail' },
      { code: '4200', name: 'Trip Revenue - Gravel', category: 'revenue', type: 'detail' },
      { code: '4300', name: 'Rental Income', category: 'revenue', type: 'detail' },
      { code: '4900', name: 'Other Income', category: 'revenue', type: 'detail' },
      // Expenses (5000s)
      { code: '5000', name: 'Expenses', category: 'expense', type: 'header' },
      { code: '5100', name: 'Fuel Expense', category: 'expense', type: 'detail' },
      { code: '5200', name: 'Driver Salaries', category: 'expense', type: 'detail' },
      { code: '5300', name: 'Maintenance & Repairs', category: 'expense', type: 'detail' },
      { code: '5400', name: 'Spare Parts Expense', category: 'expense', type: 'detail' },
      { code: '5500', name: 'Depreciation Expense', category: 'expense', type: 'detail' },
      { code: '5600', name: 'Insurance', category: 'expense', type: 'detail' },
      { code: '5700', name: 'Administration Expense', category: 'expense', type: 'detail' },
      { code: '5800', name: 'Shortage Deductions', category: 'expense', type: 'detail' },
      { code: '5900', name: 'Other Expenses', category: 'expense', type: 'detail' },
    ];

    for (const acc of defaults) {
      await prisma.account.create({ data: acc });
    }
    return res.json({ message: 'Chart of accounts seeded', count: defaults.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// --- Journal Entries ---
router.get('/journal-entries', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, page = '1', limit = '20' } = req.query as any;
    const where: any = {};
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to); }
    const skip = (Number(page) - 1) * Number(limit);
    const [entries, total] = await Promise.all([
      prisma.journalEntry.findMany({ where, skip, take: Number(limit), orderBy: { date: 'desc' },
        include: { lines: { include: { account: { select: { code: true, name: true } } } } } }),
      prisma.journalEntry.count({ where }),
    ]);
    return res.json({ entries, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/journal-entries', async (req: AuthRequest, res: Response) => {
  try {
    const { date, description, reference, lines } = req.body;
    if (!description || !lines || lines.length < 2) return res.status(400).json({ error: 'description and at least 2 lines required' });

    // Validate debits = credits
    const totalDebit = lines.reduce((s: number, l: any) => s + (Number(l.debit) || 0), 0);
    const totalCredit = lines.reduce((s: number, l: any) => s + (Number(l.credit) || 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      return res.status(400).json({ error: `Debits (${totalDebit}) must equal Credits (${totalCredit})` });
    }

    // Generate entry number
    const count = await prisma.journalEntry.count();
    const entryNumber = 'JE-' + new Date().getFullYear() + '-' + String(count + 1).padStart(6, '0');

    const entry = await prisma.journalEntry.create({ data: {
      entryNumber, date: date ? new Date(date) : new Date(),
      description, reference, source: 'manual', status: 'posted',
      totalAmount: totalDebit, createdBy: req.user?.id || '',
      lines: { create: lines.map((l: any) => ({
        accountId: l.accountId, description: l.description || '',
        debit: Number(l.debit) || 0, credit: Number(l.credit) || 0,
      }))},
    }, include: { lines: { include: { account: { select: { code: true, name: true } } } } } });

    // Update account balances
    for (const line of lines) {
      await prisma.account.update({ where: { id: line.accountId },
        data: { balance: { increment: (Number(line.debit) || 0) - (Number(line.credit) || 0) } } });
    }

    return res.status(201).json({ entry });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// --- Reports ---

// Trial Balance
router.get('/trial-balance', async (req: AuthRequest, res: Response) => {
  try {
    const accounts = await prisma.account.findMany({
      where: { type: 'detail', isActive: true },
      orderBy: { code: 'asc' },
    });

    const trialBalance = accounts.map((a: any) => {
      const debit = a.balance >= 0 ? a.balance : 0;
      const credit = a.balance < 0 ? Math.abs(a.balance) : 0;
      return { code: a.code, name: a.name, category: a.category, debit, credit };
    }).filter(a => a.debit !== 0 || a.credit !== 0);

    const totalDebit = trialBalance.reduce((s, a) => s + a.debit, 0);
    const totalCredit = trialBalance.reduce((s, a) => s + a.credit, 0);

    return res.json({ trialBalance, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Profit & Loss
router.get('/profit-loss', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const revenueAccounts = await prisma.account.findMany({
      where: { category: 'revenue', type: 'detail', isActive: true }, orderBy: { code: 'asc' },
    });
    const expenseAccounts = await prisma.account.findMany({
      where: { category: 'expense', type: 'detail', isActive: true }, orderBy: { code: 'asc' },
    });

    // If date range, compute from journal lines
    let revenues: any[], expenses: any[];
    if (from || to) {
      const dateFilter: any = {};
      if (from) dateFilter.gte = new Date(from);
      if (to) dateFilter.lte = new Date(to);

      const revLines = await prisma.journalEntryLine.findMany({
        where: { account: { category: 'revenue' }, journalEntry: { date: dateFilter } },
        include: { account: { select: { code: true, name: true } } },
      });
      const expLines = await prisma.journalEntryLine.findMany({
        where: { account: { category: 'expense' }, journalEntry: { date: dateFilter } },
        include: { account: { select: { code: true, name: true } } },
      });

      const revMap: any = {};
      for (const l of revLines) {
        if (!revMap[l.accountId]) revMap[l.accountId] = { code: l.account.code, name: l.account.name, amount: 0 };
        revMap[l.accountId].amount += (l.credit || 0) - (l.debit || 0);
      }
      revenues = Object.values(revMap);

      const expMap: any = {};
      for (const l of expLines) {
        if (!expMap[l.accountId]) expMap[l.accountId] = { code: l.account.code, name: l.account.name, amount: 0 };
        expMap[l.accountId].amount += (l.debit || 0) - (l.credit || 0);
      }
      expenses = Object.values(expMap);
    } else {
      revenues = revenueAccounts.map((a: any) => ({ code: a.code, name: a.name, amount: Math.abs(a.balance) }));
      expenses = expenseAccounts.map((a: any) => ({ code: a.code, name: a.name, amount: Math.abs(a.balance) }));
    }

    const totalRevenue = revenues.reduce((s: number, a: any) => s + a.amount, 0);
    const totalExpense = expenses.reduce((s: number, a: any) => s + a.amount, 0);

    return res.json({
      revenues, expenses, totalRevenue, totalExpense,
      netIncome: totalRevenue - totalExpense,
      margin: totalRevenue > 0 ? Math.round((totalRevenue - totalExpense) / totalRevenue * 100) : 0,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Balance Sheet
router.get('/balance-sheet', async (req: AuthRequest, res: Response) => {
  try {
    const assets = await prisma.account.findMany({
      where: { category: 'asset', type: 'detail', isActive: true }, orderBy: { code: 'asc' },
    });
    const liabilities = await prisma.account.findMany({
      where: { category: 'liability', type: 'detail', isActive: true }, orderBy: { code: 'asc' },
    });
    const equity = await prisma.account.findMany({
      where: { category: 'equity', type: 'detail', isActive: true }, orderBy: { code: 'asc' },
    });

    const totalAssets = assets.reduce((s: number, a: any) => s + a.balance, 0);
    const totalLiabilities = liabilities.reduce((s: number, a: any) => s + Math.abs(a.balance), 0);
    const totalEquity = equity.reduce((s: number, a: any) => s + Math.abs(a.balance), 0);

    // Net income from P&L
    const revAccounts = await prisma.account.findMany({ where: { category: 'revenue' } });
    const expAccounts = await prisma.account.findMany({ where: { category: 'expense' } });
    const netIncome = revAccounts.reduce((s: number, a: any) => s + Math.abs(a.balance), 0)
      - expAccounts.reduce((s: number, a: any) => s + Math.abs(a.balance), 0);

    return res.json({
      assets: assets.map((a: any) => ({ code: a.code, name: a.name, balance: a.balance })),
      liabilities: liabilities.map((a: any) => ({ code: a.code, name: a.name, balance: Math.abs(a.balance) })),
      equity: equity.map((a: any) => ({ code: a.code, name: a.name, balance: Math.abs(a.balance) })),
      totalAssets, totalLiabilities, totalEquity: totalEquity + netIncome,
      netIncome, balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity + netIncome)) < 1,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// General Ledger
router.get('/general-ledger', async (req: AuthRequest, res: Response) => {
  try {
    const { accountId, from, to } = req.query as any;
    if (!accountId) return res.status(400).json({ error: 'accountId required' });
    const where: any = { accountId };
    if (from || to) {
      where.journalEntry = { date: {} };
      if (from) where.journalEntry.date.gte = new Date(from);
      if (to) where.journalEntry.date.lte = new Date(to);
    }
    const lines = await prisma.journalEntryLine.findMany({
      where, orderBy: { journalEntry: { date: 'asc' } },
      include: { journalEntry: { select: { entryNumber: true, date: true, description: true, reference: true } } },
    });
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    let runningBalance = 0;
    const ledger = lines.map((l: any) => {
      runningBalance += (l.debit || 0) - (l.credit || 0);
      return {
        date: l.journalEntry.date, entryNumber: l.journalEntry.entryNumber,
        description: l.description || l.journalEntry.description,
        reference: l.journalEntry.reference,
        debit: l.debit, credit: l.credit, balance: runningBalance,
      };
    });
    return res.json({ account, ledger });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Fiscal periods
router.get('/fiscal-periods', async (req: AuthRequest, res: Response) => {
  try {
    const periods = await prisma.fiscalPeriod.findMany({ orderBy: [{ year: 'desc' }, { month: 'desc' }] });
    return res.json({ periods });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── Cash Book ───────────────────────────────────────────────
router.get('/cash-book', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, accountId } = req.query as any;

    // Default to cash accounts (1100, 1110, 1120)
    let cashAccountIds: string[] = [];
    if (accountId) {
      cashAccountIds = [accountId];
    } else {
      const cashAccounts = await prisma.account.findMany({
        where: { code: { in: ['1100', '1110', '1120'] }, isActive: true },
        select: { id: true },
      });
      cashAccountIds = cashAccounts.map(a => a.id);
    }

    if (cashAccountIds.length === 0) return res.json({ entries: [], openingBalance: 0, closingBalance: 0 });

    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);

    const lines = await prisma.journalEntryLine.findMany({
      where: {
        accountId: { in: cashAccountIds },
        ...(Object.keys(dateFilter).length > 0 ? { journalEntry: { date: dateFilter } } : {}),
      },
      orderBy: { journalEntry: { date: 'asc' } },
      include: {
        journalEntry: { select: { entryNumber: true, date: true, description: true, reference: true, source: true, sourceType: true, sourceId: true } },
        account: { select: { code: true, name: true } },
      },
    });

    // Calculate opening balance (sum of all entries before "from" date)
    let openingBalance = 0;
    if (from) {
      const priorLines = await prisma.journalEntryLine.findMany({
        where: {
          accountId: { in: cashAccountIds },
          journalEntry: { date: { lt: new Date(from) } },
        },
      });
      openingBalance = priorLines.reduce((s: number, l: any) => s + (l.debit || 0) - (l.credit || 0), 0);
    }

    let runningBalance = openingBalance;
    const entries = lines.map((l: any) => {
      const cashIn = l.debit || 0;
      const cashOut = l.credit || 0;
      runningBalance += cashIn - cashOut;
      return {
        date: l.journalEntry.date,
        entryNumber: l.journalEntry.entryNumber,
        description: l.journalEntry.description,
        reference: l.journalEntry.reference,
        source: l.journalEntry.source,
        sourceType: l.journalEntry.sourceType,
        sourceId: l.journalEntry.sourceId,
        account: `${l.account.code} - ${l.account.name}`,
        cashIn,
        cashOut,
        balance: runningBalance,
      };
    });

    const totalCashIn = entries.reduce((s: number, e: any) => s + e.cashIn, 0);
    const totalCashOut = entries.reduce((s: number, e: any) => s + e.cashOut, 0);

    return res.json({ entries, openingBalance, closingBalance: runningBalance, totalCashIn, totalCashOut });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── Accounting Config (Auto-posting mappings) ──────────────
router.get('/config', async (req: AuthRequest, res: Response) => {
  try {
    const configs = await prisma.accountingConfig.findMany({ orderBy: { transactionType: 'asc' } });
    // Enrich with account names
    const accountIds = new Set<string>();
    configs.forEach((c: any) => { accountIds.add(c.debitAccountId); accountIds.add(c.creditAccountId); });
    const accounts = await prisma.account.findMany({
      where: { id: { in: [...accountIds] } },
      select: { id: true, code: true, name: true },
    });
    const accountMap: any = {};
    accounts.forEach(a => { accountMap[a.id] = `${a.code} - ${a.name}`; });

    const enriched = configs.map((c: any) => ({
      ...c,
      debitAccountName: accountMap[c.debitAccountId] || 'Unknown',
      creditAccountName: accountMap[c.creditAccountId] || 'Unknown',
    }));
    return res.json({ configs: enriched });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/config', async (req: AuthRequest, res: Response) => {
  try {
    const { transactionType, debitAccountId, creditAccountId, description, isActive } = req.body;
    if (!transactionType || !debitAccountId || !creditAccountId)
      return res.status(400).json({ error: 'transactionType, debitAccountId, creditAccountId required' });

    const config = await prisma.accountingConfig.upsert({
      where: { transactionType },
      update: { debitAccountId, creditAccountId, description: description || null, isActive: isActive !== undefined ? isActive : true },
      create: { transactionType, debitAccountId, creditAccountId, description: description || transactionType.replace(/_/g, ' '), isActive: isActive !== undefined ? isActive : true },
    });
    return res.json({ config });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/config/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['debitAccountId', 'creditAccountId', 'description'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    if (req.body.isActive !== undefined) data.isActive = req.body.isActive;
    const config = await prisma.accountingConfig.update({ where: { id: req.params.id }, data });
    return res.json({ config });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Seed default accounting config mappings
router.post('/config/seed', async (req: AuthRequest, res: Response) => {
  try {
    // Find accounts by code
    const accts = await prisma.account.findMany({ select: { id: true, code: true } });
    const byCode: any = {};
    accts.forEach(a => { byCode[a.code] = a.id; });

    const required = ['1200', '4100', '5100', '1110', '2200', '5300'];
    const missing = required.filter(c => !byCode[c]);
    if (missing.length > 0) return res.status(400).json({ error: `Missing accounts: ${missing.join(', ')}. Seed chart of accounts first.` });

    const defaults = [
      { transactionType: 'trip_revenue', debitAccountId: byCode['1200'], creditAccountId: byCode['4100'], description: 'Trip completed - DR Receivable, CR Revenue' },
      { transactionType: 'fuel_purchase', debitAccountId: byCode['5100'], creditAccountId: byCode['1110'], description: 'Fuel purchase - DR Fuel Expense, CR Cash' },
      { transactionType: 'driver_advance', debitAccountId: byCode['2200'], creditAccountId: byCode['1110'], description: 'Driver advance paid - DR Advances, CR Cash' },
      { transactionType: 'cash_transfer', debitAccountId: byCode['1110'], creditAccountId: byCode['1110'], description: 'Cash transfer between cashiers (placeholder)' },
      { transactionType: 'maintenance', debitAccountId: byCode['5300'], creditAccountId: byCode['1110'], description: 'Maintenance expense - DR Maint Expense, CR Cash' },
    ];

    // Add optional mappings if accounts exist
    if (byCode['5500'] && byCode['1410']) {
      defaults.push({ transactionType: 'depreciation', debitAccountId: byCode['5500'], creditAccountId: byCode['1410'], description: 'Depreciation - DR Depr Expense, CR Accum Depr' });
    }
    if (byCode['5800']) {
      defaults.push({ transactionType: 'shortage_deduction', debitAccountId: byCode['5800'], creditAccountId: byCode['1200'], description: 'Shortage deduction - DR Shortage, CR Receivable' });
    }

    const results = [];
    for (const d of defaults) {
      const config = await prisma.accountingConfig.upsert({
        where: { transactionType: d.transactionType },
        update: {},
        create: { ...d, isActive: true },
      });
      results.push(config);
    }
    return res.json({ configs: results, count: results.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
