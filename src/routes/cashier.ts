import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { postJournalEntry } from '../utils/auto-journal';
import { createAlert } from '../utils/alert-engine';
import { requiresApproval, createApprovalRequest } from '../utils/approval';
import { sendNotification } from '../utils/telegram';
const router = Router();
router.use(authenticate);

async function logAudit(req: AuthRequest, action: string, entityType: string, entityId?: string, details?: any) {
  try {
    let validUserId = req.user?.id;
    if (validUserId) {
      const userExists = await prisma.user.findUnique({ where: { id: validUserId } });
      if (!userExists) validUserId = undefined;
    }
    await prisma.auditLog.create({
      data: {
        userId: validUserId,
        action,
        entityType,
        entityId: entityId || null,
        details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null
      }
    });
  } catch (err) {
    console.warn('AuditLog ignored:', err);
  }
}

// ── Transactions ─────────────────────────────────────────────
router.get('/transactions', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId, category, from, to, page='1', limit='30' } = req.query as any;
    const where: any = {};
    if (cashierId) where.cashierId = cashierId;
    if (category) where.category = category;
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const skip = (Number(page)-1)*Number(limit);
    const [transactions, total] = await Promise.all([
      prisma.cashTransaction.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' },
        include: { cashier: { select: { name: true } } } }),
      prisma.cashTransaction.count({ where }) ]);
    return res.json({ transactions, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delete single transaction
router.delete('/transactions/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const tx = await prisma.cashTransaction.findUnique({ where: { id } });
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });

    // Revert balance on cashier
    if (tx.type === 'in') {
      await prisma.cashier.update({ where: { id: tx.cashierId }, data: { currentBalance: { decrement: tx.amount } } });
    } else if (tx.type === 'out') {
      await prisma.cashier.update({ where: { id: tx.cashierId }, data: { currentBalance: { increment: tx.amount } } });
    }

    await prisma.cashTransaction.delete({ where: { id } });
    await logAudit(req, 'delete', 'cash_transaction', id, { cashierId: tx.cashierId, amount: tx.amount, type: tx.type });

    return res.json({ message: 'Transaction deleted successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Clear all transactions (optionally for a specific cashier)
router.delete('/transactions', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId } = req.query as any;
    const where = cashierId ? { cashierId } : {};
    const result = await prisma.cashTransaction.deleteMany({ where });
    await logAudit(req, 'clear', 'cash_transaction', cashierId, { count: result.count });
    return res.json({ message: 'Transactions cleared successfully', count: result.count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/driver-advances', async (req: AuthRequest, res: Response) => {
  try {
    const { status, driverId } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (driverId) where.driverId = driverId;
    const advances = await prisma.driverAdvance.findMany({ where, orderBy: { requestedAt: 'desc' },
      include: { driver: { select: { firstName: true, lastName: true } },
        trip: { select: { tripNumber: true } },
        cashier: { select: { name: true } } } });
    return res.json({ advances });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/driver-advances', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId, tripId, amount, reason } = req.body;
    if (!driverId || !amount) return res.status(400).json({ error: 'driverId, amount required' });
    const numAmount = Number(amount);

    // Check if this advance requires approval
    const needsApproval = await requiresApproval('large_advance', numAmount);

    const advance = await prisma.driverAdvance.create({ data: {
      driverId, tripId: tripId||null, amount: numAmount, reason,
      status: needsApproval ? 'pending_approval' : 'requested' } });

    // Auto-create approval request if above threshold
    if (needsApproval) {
      const driver = await prisma.employee.findUnique({ where: { id: driverId }, select: { firstName: true, lastName: true } });
      const driverName = driver ? `${driver.firstName} ${driver.lastName}` : 'Unknown';
      await createApprovalRequest({
        type: 'large_advance',
        entityType: 'DriverAdvance',
        entityId: advance.id,
        requestedBy: req.user?.id,
        description: `Driver advance of ETB ${numAmount.toLocaleString()} for ${driverName} - requires approval (above threshold)`,
        amount: numAmount,
        currentData: { driverId, driverName, tripId, reason },
        priority: numAmount >= 10000 ? 'high' : 'normal',
      });
      // Telegram: notify about pending approval
      sendNotification('urgent', 'system',
        `🔔 Approval Required: Large Advance`,
        `Driver advance of ETB ${numAmount.toLocaleString()} for ${driverName} requires approval.\nReason: ${reason || 'N/A'}`
      ).catch(() => {});
    }

    return res.status(201).json({
      advance,
      requiresApproval: needsApproval,
      message: needsApproval
        ? `Advance of ETB ${numAmount.toLocaleString()} requires approval. An approval request has been created.`
        : 'Advance created successfully'
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/driver-advances/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const adv = await prisma.driverAdvance.findUnique({ where: { id: req.params.id } }) as any;
    if (!adv) return res.status(404).json({ error: 'Advance not found' });

    // If pending_approval, must go through Approvals page instead
    if (adv.status === 'pending_approval') {
      return res.status(400).json({
        error: 'This advance requires approval through the Approvals workflow. Go to Approvals page to approve it.'
      });
    }

    const advance = await prisma.driverAdvance.update({ where: { id: req.params.id },
      data: { status: 'approved', approvedById: req.user?.id, approvedAt: new Date() } });
    return res.json({ advance });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/driver-advances/:id/pay', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId } = req.body;
    if (!cashierId) return res.status(400).json({ error: 'cashierId required' });
    const adv = await prisma.driverAdvance.findUnique({ where: { id: req.params.id } }) as any;
    if (!adv) return res.status(404).json({ error: 'Not found' });
    const cashier = await prisma.cashier.findUnique({ where: { id: cashierId } }) as any;
    if (!cashier) return res.status(404).json({ error: 'Cashier not found' });
    if (cashier.currentBalance < adv.amount) return res.status(400).json({ error: 'Insufficient cashier balance' });
    await prisma.$transaction(async (tx: any) => {
      await tx.driverAdvance.update({ where: { id: req.params.id },
        data: { status: 'paid', cashierId, paidAt: new Date() } });
      await tx.cashier.update({ where: { id: cashierId }, data: { currentBalance: { decrement: adv.amount } } });
      await tx.cashTransaction.create({ data: { cashierId, type: 'out', category: 'driver_advance',
        amount: adv.amount, referenceId: req.params.id, referenceType: 'driver_advance',
        description: 'Driver advance payment' } });
    });
    // Auto-post journal: DR Advances, CR Cash
    postJournalEntry({
      sourceType: 'driver_advance', sourceId: req.params.id, amount: adv.amount,
      description: `Driver advance payment - ${adv.amount} ETB`,
      createdBy: req.user?.id,
    }).catch(() => {});
    return res.json({ message: 'Advance paid' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delete single driver advance
router.delete('/driver-advances/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const adv = await prisma.driverAdvance.findUnique({ where: { id } });
    if (!adv) return res.status(404).json({ error: 'Advance not found' });

    await prisma.driverAdvance.delete({ where: { id } });
    await logAudit(req, 'delete', 'driver_advance', id, { amount: adv.amount, driverId: adv.driverId });
    return res.json({ message: 'Driver advance deleted successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Clear all driver advances
router.delete('/driver-advances', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId, driverId } = req.query as any;
    const where: any = {};
    if (cashierId) where.cashierId = cashierId;
    if (driverId) where.driverId = driverId;
    const result = await prisma.driverAdvance.deleteMany({ where });
    await logAudit(req, 'clear', 'driver_advance', undefined, { count: result.count });
    return res.json({ message: 'Driver advances cleared successfully', count: result.count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/fuel-logs', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, from, to, page='1', limit='20' } = req.query as any;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to); }
    const skip = (Number(page)-1)*Number(limit);
    const [fuelLogs, total] = await Promise.all([
      prisma.fuelLog.findMany({ where, skip, take: Number(limit), orderBy: { date: 'desc' },
        include: { vehicle: { select: { plateNumber: true } }, cashier: { select: { name: true } } } }),
      prisma.fuelLog.count({ where }) ]);
    return res.json({ fuelLogs, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delete single fuel log
router.delete('/fuel-logs/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const log = await prisma.fuelLog.findUnique({ where: { id } });
    if (!log) return res.status(404).json({ error: 'Fuel log not found' });

    await prisma.fuelLog.delete({ where: { id } });
    await logAudit(req, 'delete', 'fuel_log', id, { vehicleId: log.vehicleId, totalCost: log.totalCost });
    return res.json({ message: 'Fuel log deleted successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Clear all fuel logs
router.delete('/fuel-logs', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, cashierId } = req.query as any;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (cashierId) where.cashierId = cashierId;
    const result = await prisma.fuelLog.deleteMany({ where });
    await logAudit(req, 'clear', 'fuel_log', undefined, { count: result.count });
    return res.json({ message: 'Fuel logs cleared successfully', count: result.count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/fuel-logs', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, tripId, liters, costPerLiter, odometerKm, fuelStation, cashierId, notes } = req.body;
    if (!vehicleId || !liters || !costPerLiter) return res.status(400).json({ error: 'vehicleId, liters, costPerLiter required' });
    const totalCost = Number(liters) * Number(costPerLiter);
    const log = await prisma.$transaction(async (tx: any) => {
      const l = await tx.fuelLog.create({ data: {
        vehicleId, tripId: tripId||null, liters: Number(liters), costPerLiter: Number(costPerLiter),
        totalCost, odometerKm: odometerKm ? Number(odometerKm) : null,
        fuelStation, cashierId: cashierId||null, notes } });
      if (cashierId) {
        await tx.cashier.update({ where: { id: cashierId }, data: { currentBalance: { decrement: totalCost } } });
        await tx.cashTransaction.create({ data: { cashierId, type: 'out', category: 'fuel',
          amount: totalCost, referenceId: l.id, referenceType: 'fuel_log',
          description: 'Fuel purchase - ' + (fuelStation||'') } });
      }
      if (tripId) await tx.trip.update({ where: { id: tripId }, data: { fuelCost: { increment: totalCost } } });
      return l;
    });
    // Auto-post journal: DR Fuel Expense, CR Cash
    postJournalEntry({
      sourceType: 'fuel_purchase', sourceId: log.id, amount: totalCost,
      description: `Fuel purchase - ${Number(liters).toFixed(1)}L @ ${fuelStation || 'N/A'}`,
      reference: tripId || undefined, createdBy: req.user?.id,
    }).catch(() => {});
    return res.status(201).json({ log });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/me', async (req: AuthRequest, res: Response) => {
  try {
    let cashier = await prisma.cashier.findFirst({ where: { userId: req.user?.id, isActive: true } });
    if (!cashier) {
      // Fallback: return first active cashier
      cashier = await prisma.cashier.findFirst({ where: { isActive: true } });
    }
    if (!cashier && req.user?.id) {
      // Auto-create cashier record for this user
      const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { name: true } });
      cashier = await prisma.cashier.create({
        data: { userId: req.user.id, name: user?.name || 'Main Cashier', floatAmount: 0, currentBalance: 0, isActive: true }
      });
    }
    return res.json({ cashier });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const cashiers = await prisma.cashier.findMany({ where: { isActive: true },
      include: { user: { select: { name: true, email: true } } } });
    return res.json({ cashiers });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Create a new cashier (admin)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { userId, name, location, code, floatAmount } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    // If userId provided, check it's not already a cashier
    if (userId) {
      const existing = await prisma.cashier.findUnique({ where: { userId } });
      if (existing) return res.status(400).json({ error: 'This user already has a cashier record' });
    }

    // If no userId, we need one — find or require
    let assignUserId = userId;
    if (!assignUserId) {
      // Create a standalone cashier — use the requesting user's ID as fallback
      // but really admin should pick a user
      return res.status(400).json({ error: 'userId required — select a user to link this cashier to' });
    }

    const cashier = await prisma.cashier.create({
      data: {
        userId: assignUserId,
        name,
        location: location || null,
        code: code || null,
        floatAmount: floatAmount ? Number(floatAmount) : 0,
        currentBalance: floatAmount ? Number(floatAmount) : 0,
        isActive: true,
      }
    });
    return res.status(201).json({ cashier });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const cashier = await prisma.cashier.findUnique({ where: { id: req.params.id },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 50 } } });
    if (!cashier) return res.status(404).json({ error: 'Not found' });
    return res.json({ cashier });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/:id/transaction', async (req: AuthRequest, res: Response) => {
  try {
    const { type, category, amount, description, referenceId, referenceType,
      receiverName, paymentMethod, bankReference, transferReference, mobileReference, proofAttachment } = req.body;
    if (!type || !category || !amount) return res.status(400).json({ error: 'type, category, amount required' });
    const cashier = await prisma.cashier.findUnique({ where: { id: req.params.id } }) as any;
    if (!cashier) return res.status(404).json({ error: 'Not found' });
    if (type === 'out' && cashier.currentBalance < Number(amount))
      return res.status(400).json({ error: 'Insufficient balance' });

    // B3: Customer payments/collections must go to Main Cash Center first
    if (type === 'in' && category === 'customer_payment') {
      return res.status(400).json({ error: 'Customer collections must go through Main Cash Center. Use /api/main-cash/customer-collection or /api/settlements/:id/record-collection endpoint.' });
    }

    // B1: Cash-out requires an approved payment request (except for internal transfers/allocations)
    if (type === 'out' && !['deposit', 'allocation', 'transfer'].includes(category)) {
      const { paymentRequestId } = req.body;
      if (paymentRequestId) {
        const payReq = await prisma.paymentRequest.findUnique({ where: { id: paymentRequestId } }) as any;
        if (!payReq || payReq.status !== 'approved') {
          return res.status(400).json({ error: 'Payment request must be approved before cash-out. Provide a valid approved paymentRequestId.' });
        }
      }
      // Note: We log a warning but don't block yet to allow transition period
      // TODO: After transition period, uncomment to enforce:
      // if (!paymentRequestId) return res.status(400).json({ error: 'Cash-out requires an approved payment request ID.' });
    }

    // Check for open session on cash-out
    const today = new Date().toISOString().split('T')[0];
    if (type === 'out') {
      const session = await prisma.cashierSession.findUnique({
        where: { cashierId_sessionDate: { cashierId: req.params.id, sessionDate: today } }
      }) as any;
      if (session && session.status !== 'open') {
        return res.status(400).json({ error: 'Session is closed. Open a new session to process cash-out.' });
      }
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.cashTransaction.create({ data: { cashierId: req.params.id, type, category,
        amount: Number(amount), description: description||category,
        referenceId: referenceId||null, referenceType: referenceType||null,
        receiverName: receiverName||null,
        paymentMethod: paymentMethod||'cash',
        bankReference: bankReference||null,
        transferReference: transferReference||null,
        mobileReference: mobileReference||null,
        proofAttachment: proofAttachment||null,
        approvedBy: req.user?.id } });
      await tx.cashier.update({ where: { id: req.params.id }, data: {
        currentBalance: type === 'in' ? { increment: Number(amount) } : { decrement: Number(amount) } } });
      // Update session totals if session exists
      const openSession = await tx.cashierSession.findUnique({
        where: { cashierId_sessionDate: { cashierId: req.params.id, sessionDate: today } }
      });
      if (openSession && openSession.status === 'open') {
        await tx.cashierSession.update({ where: { id: openSession.id }, data: {
          ...(type === 'in' ? { totalCashIn: { increment: Number(amount) } } : { totalCashOut: { increment: Number(amount) } })
        } });
      }
    });
    return res.json({ message: 'Transaction recorded' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Fuel efficiency analytics (#5)
router.get('/fuel-analytics', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from);
    if (to) dateFilter.lte = new Date(to);
    const where: any = {};
    if (from || to) where.date = dateFilter;

    const fuelLogs = await prisma.fuelLog.findMany({
      where, include: {
        vehicle: { select: { plateNumber: true, make: true, category: true } },
      },
    });

    // Group by vehicle
    const vehicleMap: any = {};
    for (const log of fuelLogs) {
      const vid = log.vehicleId;
      if (!vehicleMap[vid]) {
        vehicleMap[vid] = {
          vehicleId: vid,
          plateNumber: log.vehicle?.plateNumber || 'Unknown',
          make: log.vehicle?.make || '',
          category: log.vehicle?.category || '',
          totalLiters: 0, totalCost: 0, tripCount: 0, logCount: 0,
          totalKm: 0, totalTons: 0,
        };
      }
      vehicleMap[vid].totalLiters += log.liters;
      vehicleMap[vid].totalCost += log.totalCost;
      vehicleMap[vid].logCount++;
    }

    // Get trip data for each vehicle to compute tons and km
    for (const vid of Object.keys(vehicleMap)) {
      const tripWhere: any = { vehicleId: vid, status: 'completed' };
      if (from || to) tripWhere.tripDate = dateFilter;
      const trips = await prisma.trip.findMany({ where: tripWhere, select: { deliveredQuantityTons: true } });
      vehicleMap[vid].tripCount = trips.length;
      vehicleMap[vid].totalTons = trips.reduce((s: number, t: any) => s + (t.deliveredQuantityTons || 0), 0);
      // KM from km logs
      const kmLogs = await prisma.kmLog.findMany({
        where: { vehicleId: vid, ...(from || to ? { date: dateFilter } : {}) },
        orderBy: { kmReading: 'asc' }, select: { kmReading: true },
      });
      if (kmLogs.length >= 2) {
        vehicleMap[vid].totalKm = kmLogs[kmLogs.length - 1].kmReading - kmLogs[0].kmReading;
      }
    }

    // Calculate efficiency metrics
    const vehicles = Object.values(vehicleMap).map((v: any) => ({
      ...v,
      fuelPerKm: v.totalKm > 0 ? Number((v.totalLiters / v.totalKm).toFixed(3)) : null,
      fuelPerTon: v.totalTons > 0 ? Number((v.totalLiters / v.totalTons).toFixed(2)) : null,
      fuelPerTrip: v.tripCount > 0 ? Number((v.totalLiters / v.tripCount).toFixed(1)) : null,
      costPerKm: v.totalKm > 0 ? Number((v.totalCost / v.totalKm).toFixed(2)) : null,
      costPerTon: v.totalTons > 0 ? Number((v.totalCost / v.totalTons).toFixed(2)) : null,
    }));

    // Fleet averages
    const withKm = vehicles.filter((v: any) => v.fuelPerKm !== null);
    const withTons = vehicles.filter((v: any) => v.fuelPerTon !== null);
    const fleetAvgFuelPerKm = withKm.length > 0 ? withKm.reduce((s: number, v: any) => s + v.fuelPerKm, 0) / withKm.length : 0;
    const fleetAvgFuelPerTon = withTons.length > 0 ? withTons.reduce((s: number, v: any) => s + v.fuelPerTon, 0) / withTons.length : 0;

    // Flag anomalies (>1.5x fleet average)
    for (const v of vehicles as any[]) {
      v.isAnomaly = false;
      if (v.fuelPerKm && fleetAvgFuelPerKm > 0 && v.fuelPerKm > fleetAvgFuelPerKm * 1.5) v.isAnomaly = true;
      if (v.fuelPerTon && fleetAvgFuelPerTon > 0 && v.fuelPerTon > fleetAvgFuelPerTon * 1.5) v.isAnomaly = true;
    }

    // Sort by total fuel cost desc
    vehicles.sort((a: any, b: any) => b.totalCost - a.totalCost);

    const totalFleetFuel = vehicles.reduce((s: number, v: any) => s + v.totalCost, 0);
    const totalFleetLiters = vehicles.reduce((s: number, v: any) => s + v.totalLiters, 0);
    const anomalyCount = vehicles.filter((v: any) => v.isAnomaly).length;

    return res.json({
      vehicles,
      summary: {
        totalCost: totalFleetFuel, totalLiters: totalFleetLiters,
        vehicleCount: vehicles.length, anomalyCount,
        fleetAvgFuelPerKm: Number(fleetAvgFuelPerKm.toFixed(3)),
        fleetAvgFuelPerTon: Number(fleetAvgFuelPerTon.toFixed(2)),
      },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── PHASE 3: SESSION MANAGEMENT ─────────────────────────────────────────────

// Daily reconciliation - all cashiers for a date (must be before /:id routes)
router.get('/sessions/daily-reconciliation', async (req: AuthRequest, res: Response) => {
  try {
    const { date } = req.query as any;
    const sessionDate = date || new Date().toISOString().split('T')[0];
    const sessions = await prisma.cashierSession.findMany({
      where: { sessionDate },
      include: { cashier: { select: { name: true, location: true, code: true } } }
    });
    const allCashiers = await prisma.cashier.findMany({ where: { isActive: true } });
    const sessionCashierIds = sessions.map((s: any) => s.cashierId);
    const missingCashiers = allCashiers.filter(c => !sessionCashierIds.includes(c.id));
    return res.json({ sessions, missingCashiers, date: sessionDate });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Reconcile a session (admin)
router.put('/sessions/:sessionId/reconcile', async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.cashierSession.findUnique({ where: { id: req.params.sessionId } }) as any;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status !== 'closed') return res.status(400).json({ error: 'Session must be closed first' });

    const updated = await prisma.cashierSession.update({
      where: { id: req.params.sessionId },
      data: { status: 'reconciled', reconciledBy: req.user?.id, reconciledAt: new Date() }
    });
    return res.json({ session: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Open a daily session
router.post('/:id/open-session', async (req: AuthRequest, res: Response) => {
  try {
    const cashier = await prisma.cashier.findUnique({ where: { id: req.params.id } }) as any;
    if (!cashier) return res.status(404).json({ error: 'Cashier not found' });

    const today = new Date().toISOString().split('T')[0];
    const existing = await prisma.cashierSession.findUnique({
      where: { cashierId_sessionDate: { cashierId: req.params.id, sessionDate: today } }
    });
    if (existing) return res.status(400).json({ error: 'Session already exists for today' });

    const session = await prisma.cashierSession.create({
      data: {
        cashierId: req.params.id,
        sessionDate: today,
        openingBalance: cashier.currentBalance,
        status: 'open',
      }
    });
    return res.status(201).json({ session });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Close a session
router.post('/:id/close-session', async (req: AuthRequest, res: Response) => {
  try {
    const { closingBalance, notes } = req.body;
    if (closingBalance === undefined) return res.status(400).json({ error: 'closingBalance required' });

    const today = new Date().toISOString().split('T')[0];
    const session = await prisma.cashierSession.findUnique({
      where: { cashierId_sessionDate: { cashierId: req.params.id, sessionDate: today } }
    }) as any;
    if (!session) return res.status(404).json({ error: 'No open session for today' });
    if (session.status !== 'open') return res.status(400).json({ error: 'Session already closed' });

    const expectedBalance = session.openingBalance + session.totalCashIn - session.totalCashOut;
    const variance = Number(closingBalance) - expectedBalance;

    const updated = await prisma.cashierSession.update({
      where: { id: session.id },
      data: {
        closingBalance: Number(closingBalance),
        expectedBalance,
        variance,
        status: 'closed',
        closedAt: new Date(),
        closedBy: req.user?.id,
        notes: notes || null,
      }
    });
    // Create alert if variance exceeds threshold
    if (Math.abs(variance) >= 100) {
      const cashier = await prisma.cashier.findUnique({ where: { id: req.params.id }, select: { name: true } });
      createAlert({
        type: 'cash_variance', severity: Math.abs(variance) >= 500 ? 'critical' : 'urgent',
        title: `Cash Variance: ${cashier?.name || 'Unknown'}`,
        message: `Session closed with variance of ETB ${variance.toFixed(2)} (Expected: ${expectedBalance.toFixed(2)}, Actual: ${Number(closingBalance).toFixed(2)})`,
        entityType: 'cashier', entityId: req.params.id,
      }).catch(() => {});
    }
    return res.json({ session: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Get sessions for a cashier
router.get('/:id/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, status } = req.query as any;
    const where: any = { cashierId: req.params.id };
    if (status) where.status = status;
    if (from || to) {
      where.sessionDate = {};
      if (from) where.sessionDate.gte = from;
      if (to) where.sessionDate.lte = to;
    }
    const sessions = await prisma.cashierSession.findMany({
      where, orderBy: { sessionDate: 'desc' },
      include: { cashier: { select: { name: true } } }
    });
    return res.json({ sessions });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delete single session
router.delete('/sessions/:sessionId', async (req: AuthRequest, res: Response) => {
  try {
    const session = await prisma.cashierSession.findUnique({ where: { id: req.params.sessionId } });
    if (!session) return res.status(404).json({ error: 'Session not found' });

    await prisma.cashierSession.delete({ where: { id: req.params.sessionId } });
    await logAudit(req, 'delete', 'cashier_session', req.params.sessionId, { cashierId: session.cashierId, date: session.sessionDate });
    return res.json({ message: 'Session deleted successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Clear all sessions
router.delete('/sessions', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId } = req.query as any;
    const where = cashierId ? { cashierId } : {};
    const result = await prisma.cashierSession.deleteMany({ where });
    await logAudit(req, 'clear', 'cashier_session', cashierId, { count: result.count });
    return res.json({ message: 'Sessions cleared successfully', count: result.count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Clear all transactions and sessions for a specific cashier and reset balance to float
router.post('/:id/clear', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cashier = await prisma.cashier.findUnique({ where: { id } });
    if (!cashier) return res.status(404).json({ error: 'Cashier not found' });

    await prisma.cashTransaction.deleteMany({ where: { cashierId: id } });
    await prisma.cashierSession.deleteMany({ where: { cashierId: id } });
    await prisma.cashAllocation.deleteMany({ where: { cashierId: id } });
    await prisma.driverAdvance.updateMany({ where: { cashierId: id }, data: { cashierId: null } });
    await prisma.fuelLog.updateMany({ where: { cashierId: id }, data: { cashierId: null } });
    await prisma.rentalPayment.updateMany({ where: { cashierId: id }, data: { cashierId: null } });

    const updated = await prisma.cashier.update({
      where: { id },
      data: { currentBalance: cashier.floatAmount || 0 }
    });

    await logAudit(req, 'clear_data', 'cashier', id, { cashierName: cashier.name, resetBalance: updated.currentBalance });
    return res.json({ message: 'Cashier data cleared and balance reset successfully', cashier: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.delete('/:id/clear', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cashier = await prisma.cashier.findUnique({ where: { id } });
    if (!cashier) return res.status(404).json({ error: 'Cashier not found' });

    await prisma.cashTransaction.deleteMany({ where: { cashierId: id } });
    await prisma.cashierSession.deleteMany({ where: { cashierId: id } });
    await prisma.cashAllocation.deleteMany({ where: { cashierId: id } });
    await prisma.driverAdvance.updateMany({ where: { cashierId: id }, data: { cashierId: null } });
    await prisma.fuelLog.updateMany({ where: { cashierId: id }, data: { cashierId: null } });
    await prisma.rentalPayment.updateMany({ where: { cashierId: id }, data: { cashierId: null } });

    const updated = await prisma.cashier.update({
      where: { id },
      data: { currentBalance: cashier.floatAmount || 0 }
    });

    await logAudit(req, 'clear_data', 'cashier', id, { cashierName: cashier.name, resetBalance: updated.currentBalance });
    return res.json({ message: 'Cashier data cleared and balance reset successfully', cashier: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delete a cashier account permanently
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const cashier = await prisma.cashier.findUnique({ where: { id } });
    if (!cashier) return res.status(404).json({ error: 'Cashier not found' });

    await prisma.cashTransaction.deleteMany({ where: { cashierId: id } });
    await prisma.cashierSession.deleteMany({ where: { cashierId: id } });
    await prisma.cashAllocation.deleteMany({ where: { cashierId: id } });
    await prisma.cashTransfer.deleteMany({ where: { OR: [{ fromCashierId: id }, { toCashierId: id }] } });
    await prisma.driverAdvance.updateMany({ where: { cashierId: id }, data: { cashierId: null } });
    await prisma.fuelLog.updateMany({ where: { cashierId: id }, data: { cashierId: null } });
    await prisma.rentalPayment.updateMany({ where: { cashierId: id }, data: { cashierId: null } });

    await prisma.cashier.delete({ where: { id } });

    await logAudit(req, 'delete', 'cashier', id, { name: cashier.name });
    return res.json({ message: 'Cashier deleted successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Update cashier location/code
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { location, code, name, floatAmount } = req.body;
    const data: any = {};
    if (location !== undefined) data.location = location;
    if (code !== undefined) data.code = code;
    if (name !== undefined) data.name = name;
    if (floatAmount !== undefined) data.floatAmount = Number(floatAmount);
    const cashier = await prisma.cashier.update({ where: { id: req.params.id }, data });
    return res.json({ cashier });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;