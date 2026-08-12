import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// Get ledger for a driver
router.get('/:driverId', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId } = req.params;
    const driver = await prisma.employee.findUnique({ where: { id: driverId }, select: { firstName: true, lastName: true, empNumber: true } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const entries = await prisma.driverLedgerEntry.findMany({
      where: { driverId }, orderBy: { date: 'desc' }, take: 200,
    });

    const totals = entries.reduce((acc, e) => {
      if (e.type === 'credit') acc.totalCredits += e.amount;
      else acc.totalDebits += e.amount;
      return acc;
    }, { totalCredits: 0, totalDebits: 0 });

    return res.json({ driver, entries, ...totals, balance: totals.totalCredits - totals.totalDebits });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// List all driver ledger summaries
router.get('/', async (_req: AuthRequest, res: Response) => {
  try {
    const drivers = await prisma.employee.findMany({
      where: { role: 'driver', status: 'active' },
      select: { id: true, firstName: true, lastName: true, empNumber: true },
    });

    const summaries = await Promise.all(drivers.map(async (d) => {
      const entries = await prisma.driverLedgerEntry.findMany({ where: { driverId: d.id } });
      const credits = entries.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
      const debits = entries.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
      return { ...d, totalCredits: credits, totalDebits: debits, balance: credits - debits, entryCount: entries.length };
    }));

    return res.json({ drivers: summaries });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Add ledger entry
router.post('/:driverId', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId } = req.params;
    const { type, category, amount, description, referenceId, referenceType, date } = req.body;
    if (!type || !category || !amount || !description) {
      return res.status(400).json({ error: 'type, category, amount, description required' });
    }

    // Calculate running balance
    const existing = await prisma.driverLedgerEntry.findMany({ where: { driverId } });
    const credits = existing.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
    const debits = existing.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
    const currentBalance = credits - debits;
    const newBalance = type === 'credit' ? currentBalance + Number(amount) : currentBalance - Number(amount);

    const entry = await prisma.driverLedgerEntry.create({
      data: {
        driverId, type, category, amount: Number(amount), balance: newBalance,
        description, referenceId, referenceType,
        date: date ? new Date(date) : new Date(),
      }
    });

    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'create', entityType: 'driver_ledger',
      entityId: entry.id, details: JSON.stringify({ driverId, type, category, amount })
    }});

    return res.status(201).json({ entry });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Auto-sync: rebuild ledger from trips, advances, payroll for a driver
router.post('/:driverId/sync', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId } = req.params;

    // Get all trips with shortage deductions
    const trips = await prisma.trip.findMany({
      where: { driverId, status: 'completed' },
      select: { id: true, tripNumber: true, shortageDeduction: true, driverAdvanceGiven: true, tripDate: true, revenue: true },
    });

    // Get all advances
    const advances = await prisma.driverAdvance.findMany({
      where: { driverId, status: 'paid' },
      select: { id: true, amount: true, paidAt: true, reason: true },
    });

    // Get payrolls
    const payrolls = await prisma.payroll.findMany({
      where: { employeeId: driverId, status: 'paid' },
      select: { id: true, netSalary: true, perDiem: true, paidAt: true, month: true, year: true },
    });

    // Build entries
    const entries: any[] = [];
    let balance = 0;

    // Add payroll credits
    for (const p of payrolls) {
      balance += p.netSalary;
      entries.push({ driverId, type: 'credit', category: 'salary', amount: p.netSalary, balance, description: `Salary ${p.month}/${p.year}`, referenceId: p.id, referenceType: 'payroll', date: p.paidAt || new Date() });
      if (p.perDiem > 0) {
        balance += p.perDiem;
        entries.push({ driverId, type: 'credit', category: 'per_diem', amount: p.perDiem, balance, description: `Per diem ${p.month}/${p.year}`, referenceId: p.id, referenceType: 'payroll', date: p.paidAt || new Date() });
      }
    }

    // Add advance debits
    for (const a of advances) {
      balance -= a.amount;
      entries.push({ driverId, type: 'debit', category: 'advance', amount: a.amount, balance, description: a.reason || 'Driver advance', referenceId: a.id, referenceType: 'advance', date: a.paidAt || new Date() });
    }

    // Add shortage debits from trips
    for (const t of trips) {
      if (t.shortageDeduction && t.shortageDeduction > 0) {
        balance -= t.shortageDeduction;
        entries.push({ driverId, type: 'debit', category: 'shortage', amount: t.shortageDeduction, balance, description: `Shortage deduction trip ${t.tripNumber}`, referenceId: t.id, referenceType: 'trip', date: t.tripDate });
      }
    }

    // Clear old and insert
    await prisma.driverLedgerEntry.deleteMany({ where: { driverId } });
    if (entries.length > 0) {
      await prisma.driverLedgerEntry.createMany({ data: entries });
    }

    return res.json({ message: 'Ledger synced', entryCount: entries.length, balance });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
