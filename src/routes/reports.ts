import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// ─── EXISTING REPORTS ─────────────────────────────────────────

router.get('/profit-per-vehicle', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = { status: 'completed' };
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }
    const vehicles = await prisma.vehicle.findMany({
      select: { id: true, plateNumber: true, make: true, model: true,
        depreciation: { select: { monthlyDepreciation: true } },
        trips: { where, select: { revenue: true, fuelCost: true, shortageDeduction: true } },
        workOrders: { where: { status: 'completed' }, select: { totalCost: true } } } });
    const result = vehicles.map((v: any) => {
      const revenue = v.trips.reduce((s: number, t: any) => s+(t.revenue||0), 0);
      const fuel = v.trips.reduce((s: number, t: any) => s+(t.fuelCost||0), 0);
      const shortage = v.trips.reduce((s: number, t: any) => s+(t.shortageDeduction||0), 0);
      const maint = v.workOrders.reduce((s: number, w: any) => s+(w.totalCost||0), 0);
      const depr = v.depreciation?.monthlyDepreciation || 0;
      return { vehicleId: v.id, plateNumber: v.plateNumber, make: v.make, model: v.model,
        revenue, fuelCost: fuel, maintenanceCost: maint, shortageDeduction: shortage,
        monthlyDepreciation: depr, grossProfit: revenue-fuel-maint-shortage-depr, tripCount: v.trips.length };
    });
    return res.json({ report: result.sort((a: any, b: any) => b.grossProfit-a.grossProfit) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/fleet-utilization', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const tWhere: any = {};
    if (from || to) { tWhere.tripDate = {}; if (from) tWhere.tripDate.gte = new Date(from); if (to) tWhere.tripDate.lte = new Date(to); }
    const vehicles = await prisma.vehicle.findMany({
      select: { id: true, plateNumber: true, make: true, model: true, status: true, capacityTons: true,
        trips: { where: tWhere, select: { status: true, deliveredQuantityTons: true, plannedQuantityTons: true } } } });
    const result = vehicles.map((v: any) => {
      const done = v.trips.filter((t: any) => t.status === 'completed');
      const tonnage = done.reduce((s: number, t: any) => s+(t.deliveredQuantityTons||0), 0);
      const planned = done.reduce((s: number, t: any) => s+(t.plannedQuantityTons||0), 0);
      return { vehicleId: v.id, plateNumber: v.plateNumber, make: v.make, model: v.model,
        status: v.status, totalTrips: v.trips.length, completedTrips: done.length, totalTonnage: tonnage,
        utilizationPct: planned>0 ? Math.round(tonnage/planned*100) : 0 };
    });
    return res.json({ report: result });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/cashier-summary', async (req: AuthRequest, res: Response) => {
  try {
    const cashiers = await prisma.cashier.findMany({ include: { transactions: true } });
    const result = cashiers.map((c: any) => ({
      name: c.name, currentBalance: c.currentBalance, floatAmount: c.floatAmount,
      totalIn: c.transactions.filter((t: any) => t.type==='in').reduce((s: number, t: any) => s+t.amount, 0),
      totalOut: c.transactions.filter((t: any) => t.type==='out').reduce((s: number, t: any) => s+t.amount, 0),
      txCount: c.transactions.length }));
    return res.json({ report: result });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/payroll-summary', async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.query as any;
    const where: any = {};
    if (month) where.month = Number(month);
    if (year) where.year = Number(year);
    const payrolls = await prisma.payroll.findMany({ where,
      include: { employee: { select: { firstName: true, lastName: true, department: true } } } });
    return res.json({ summary: {
      headCount: payrolls.length,
      totalNet: payrolls.reduce((s: number, p: any) => s+p.netSalary, 0),
      totalEarnings: payrolls.reduce((s: number, p: any) => s+p.totalEarnings, 0),
      totalDeductions: payrolls.reduce((s: number, p: any) => s+p.totalDeductions, 0) }, payrolls });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/maintenance-cost', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = { status: 'completed' };
    if (from || to) { where.updatedAt = {}; if (from) where.updatedAt.gte = new Date(from); if (to) where.updatedAt.lte = new Date(to); }
    const wos = await prisma.workOrder.findMany({ where, include: { vehicle: { select: { plateNumber: true, make: true } } } });
    const byVehicle: any = {};
    for (const wo of wos) {
      const k = wo.vehicle?.plateNumber || 'Unknown';
      if (!byVehicle[k]) byVehicle[k] = { plateNumber: k, make: wo.vehicle?.make, count: 0, totalCost: 0 };
      byVehicle[k].count++; byVehicle[k].totalCost += wo.totalCost || 0;
    }
    return res.json({ report: Object.values(byVehicle) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/customer-performance', async (req: AuthRequest, res: Response) => {
  try {
    const customers = await prisma.customer.findMany({
      include: { trips: { where: { status: 'completed' }, select: { revenue: true, deliveredQuantityTons: true } },
        orders: { select: { status: true } } } });
    const result = customers.map((c: any) => ({
      companyName: c.companyName, totalOrders: c.orders.length,
      totalTrips: c.trips.length,
      totalTonnage: c.trips.reduce((s: number, t: any) => s+(t.deliveredQuantityTons||0), 0),
      totalRevenue: c.trips.reduce((s: number, t: any) => s+(t.revenue||0), 0) }));
    return res.json({ report: result.sort((a: any, b: any) => b.totalRevenue-a.totalRevenue) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/tonnage-daily', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const start = from ? new Date(from) : new Date(Date.now()-30*86400000);
    const end = to ? new Date(to) : new Date();
    const trips = await prisma.trip.findMany({ where: { status: 'completed', tripDate: { gte: start, lte: end } },
      select: { tripDate: true, deliveredQuantityTons: true, revenue: true, orderType: true } });
    const daily: any = {};
    for (const t of trips) {
      const day = new Date(t.tripDate).toISOString().slice(0,10);
      if (!daily[day]) daily[day] = { date: day, tonnage: 0, revenue: 0, cement: 0, gravel: 0 };
      daily[day].tonnage += t.deliveredQuantityTons||0;
      daily[day].revenue += t.revenue||0;
      if (t.orderType==='cement') daily[day].cement += t.deliveredQuantityTons||0;
      else daily[day].gravel += t.deliveredQuantityTons||0;
    }
    return res.json({ report: Object.values(daily).sort((a: any, b: any) => a.date.localeCompare(b.date)) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/financial', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = { status: 'completed' };
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }
    const trips = await prisma.trip.findMany({ where,
      select: { tripDate: true, revenue: true, fuelCost: true, shortageDeduction: true, driverAdvanceGiven: true, customer: { select: { companyName: true } } } });
    const rentalTrips = await prisma.rentalTrip.findMany({ where: { tripDate: where.tripDate },
      select: { tripDate: true, customerRevenue: true, rentalPayable: true, grossMargin: true } });
    const totalRevenue = trips.reduce((s: number, t: any) => s + (t.revenue || 0), 0);
    const totalFuelCost = trips.reduce((s: number, t: any) => s + (t.fuelCost || 0), 0);
    const totalDriverCost = trips.reduce((s: number, t: any) => s + (t.driverAdvanceGiven || 0), 0);
    const totalRentalCost = rentalTrips.reduce((s: number, t: any) => s + (t.rentalPayable || 0), 0);
    const grossMargin = totalRevenue - totalFuelCost - totalDriverCost - totalRentalCost;
    const monthly: any = {};
    for (const t of trips) {
      const m = new Date(t.tripDate).toISOString().slice(0, 7);
      if (!monthly[m]) monthly[m] = { month: m, revenue: 0, costs: 0 };
      monthly[m].revenue += t.revenue || 0;
      monthly[m].costs += (t.fuelCost || 0) + (t.driverAdvanceGiven || 0);
    }
    const byCustomer: any = {};
    for (const t of trips) {
      const n = t.customer?.companyName || 'Unknown';
      if (!byCustomer[n]) byCustomer[n] = { name: n, revenue: 0 };
      byCustomer[n].revenue += t.revenue || 0;
    }
    return res.json({ summary: { totalRevenue, totalFuelCost, totalDriverCost, totalRentalCost, grossMargin },
      monthly: Object.values(monthly).sort((a: any, b: any) => a.month.localeCompare(b.month)),
      byCustomer: Object.values(byCustomer).sort((a: any, b: any) => b.revenue - a.revenue) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/trips', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = { status: 'completed' };
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }
    const trips = await prisma.trip.findMany({ where, include: { vehicle: { select: { plateNumber: true } } } });
    const totalTrips = trips.length;
    const totalTonnage = trips.reduce((s: number, t: any) => s + (t.deliveredQuantityTons || 0), 0);
    const totalShortage = trips.reduce((s: number, t: any) => s + (t.shortage || 0), 0);
    const avgCycleMinutes = trips.filter((t: any) => t.totalCycleMinutes).reduce((s: number, t: any, _: any, arr: any) => s + t.totalCycleMinutes / arr.length, 0);
    const daily: any = {};
    for (const t of trips) {
      const d = new Date(t.tripDate).toISOString().slice(0, 10);
      if (!daily[d]) daily[d] = { date: d, trips: 0, tonnage: 0 };
      daily[d].trips++; daily[d].tonnage += t.deliveredQuantityTons || 0;
    }
    const byVehicle: any = {};
    for (const t of trips) {
      const k = t.vehicleId;
      if (!byVehicle[k]) byVehicle[k] = { vehicleId: k, plateNumber: t.vehicle?.plateNumber, trips: 0, tonnage: 0, revenue: 0, shortage: 0 };
      byVehicle[k].trips++; byVehicle[k].tonnage += t.deliveredQuantityTons || 0;
      byVehicle[k].revenue += t.revenue || 0; byVehicle[k].shortage += t.shortage || 0;
    }
    return res.json({ summary: { totalTrips, totalTonnage, totalShortage, avgCycleMinutes },
      daily: Object.values(daily).sort((a: any, b: any) => a.date.localeCompare(b.date)),
      byVehicle: Object.values(byVehicle) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/fleet', async (req: AuthRequest, res: Response) => {
  try {
    const [vehicles, maint] = await Promise.all([
      prisma.vehicle.findMany({ include: { depreciation: { select: { monthlyDepreciation: true } } } }),
      prisma.maintenanceSchedule.findMany({ where: { nextDueDate: { lte: new Date(Date.now() + 30 * 86400000) } },
        include: { vehicle: { select: { plateNumber: true } } } })
    ]);
    const statusBreakdown: any = {};
    for (const v of vehicles) { if (!statusBreakdown[v.status]) statusBreakdown[v.status] = { status: v.status, count: 0 }; statusBreakdown[v.status].count++; }
    const totalDepreciation = vehicles.reduce((s: number, v: any) => s + (v.depreciation?.monthlyDepreciation || 0), 0);
    return res.json({ summary: { total: vehicles.length, active: vehicles.filter((v: any) => v.status === 'active').length,
        inMaintenance: vehicles.filter((v: any) => v.status === 'maintenance').length, totalDepreciation },
      statusBreakdown: Object.values(statusBreakdown), maintenanceDue: maint });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/kpis', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const tWhere: any = { status: 'completed' };
    if (from || to) { tWhere.tripDate = {}; if (from) tWhere.tripDate.gte = new Date(from); if (to) tWhere.tripDate.lte = new Date(to); }
    const trips = await prisma.trip.findMany({ where: tWhere,
      include: { driver: { select: { id: true, firstName: true, lastName: true } } } });
    const totalRevenue = trips.reduce((s: number, t: any) => s + (t.revenue || 0), 0);
    const totalTonnage = trips.reduce((s: number, t: any) => s + (t.deliveredQuantityTons || 0), 0);
    const totalShortage = trips.reduce((s: number, t: any) => s + (t.shortage || 0), 0);
    const avgRevPerTrip = trips.length > 0 ? totalRevenue / trips.length : 0;
    const shortageRate = totalTonnage > 0 ? (totalShortage / (totalTonnage + totalShortage) * 100) : 0;
    const byDriver: any = {};
    for (const t of trips) {
      const k = t.driverId;
      if (!byDriver[k]) byDriver[k] = { driverId: k, firstName: t.driver?.firstName, lastName: t.driver?.lastName, trips: 0, tonnage: 0, revenue: 0, shortage: 0 };
      byDriver[k].trips++; byDriver[k].tonnage += t.deliveredQuantityTons || 0;
      byDriver[k].revenue += t.revenue || 0; byDriver[k].shortage += t.shortage || 0;
    }
    return res.json({ kpis: { totalTrips: trips.length, totalRevenue, totalTonnage, totalShortage,
        avgRevenuePerTrip: Math.round(avgRevPerTrip), shortageRate: Math.round(shortageRate * 100) / 100 },
      driverPerformance: Object.values(byDriver).sort((a: any, b: any) => b.revenue - a.revenue) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── PHASE 9: NEW REPORT ENDPOINTS ───────────────────────────

// Operational: Trip summary by status
router.get('/trip-summary', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }
    const trips = await prisma.trip.findMany({ where, select: { status: true, revenue: true, deliveredQuantityTons: true, shortage: true, fuelCost: true } });
    const byStatus: any = {};
    for (const t of trips) {
      if (!byStatus[t.status]) byStatus[t.status] = { status: t.status, count: 0, revenue: 0, tonnage: 0, shortage: 0 };
      byStatus[t.status].count++;
      byStatus[t.status].revenue += t.revenue || 0;
      byStatus[t.status].tonnage += t.deliveredQuantityTons || 0;
      byStatus[t.status].shortage += t.shortage || 0;
    }
    const totals = {
      totalTrips: trips.length,
      totalRevenue: trips.reduce((s, t) => s + (t.revenue || 0), 0),
      totalTonnage: trips.reduce((s, t) => s + (t.deliveredQuantityTons || 0), 0),
      avgRevenuePerTrip: trips.length > 0 ? trips.reduce((s, t) => s + (t.revenue || 0), 0) / trips.length : 0,
    };
    return res.json({ byStatus: Object.values(byStatus), totals, total: trips.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Operational: Order fulfillment
router.get('/order-fulfillment', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.orderDate = {}; if (from) where.orderDate.gte = new Date(from); if (to) where.orderDate.lte = new Date(to); }
    const orders = await prisma.customerOrder.findMany({
      where, select: { id: true, orderNumber: true, status: true, quantity: true, totalDelivered: true, totalTrips: true,
        customer: { select: { companyName: true } } },
    });
    const byStatus: any = {};
    for (const o of orders) {
      if (!byStatus[o.status]) byStatus[o.status] = { status: o.status, count: 0 };
      byStatus[o.status].count++;
    }
    const fulfillment = orders.map(o => ({
      orderNumber: o.orderNumber, customer: (o as any).customer?.companyName,
      status: o.status, ordered: o.quantity, delivered: o.totalDelivered || 0,
      trips: o.totalTrips || 0,
      fulfillmentPct: o.quantity > 0 ? Number((((o.totalDelivered || 0) / o.quantity) * 100).toFixed(1)) : 0,
    }));
    const fullyDelivered = orders.filter(o => (o.totalDelivered || 0) >= o.quantity && o.quantity > 0).length;
    const inProgress = orders.filter(o => (o.totalDelivered || 0) > 0 && (o.totalDelivered || 0) < o.quantity).length;
    const summary = {
      totalOrders: orders.length,
      fullyDelivered,
      inProgress,
      fulfillmentRate: orders.length > 0 ? (fullyDelivered / orders.length) * 100 : 0,
    };
    return res.json({ orders: fulfillment, byStatus: Object.values(byStatus), summary, total: orders.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Operational: POD status
router.get('/pod-status', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = { status: 'completed' };
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }
    const trips = await prisma.trip.findMany({
      where, select: { tripNumber: true, tripDate: true, podUrl: true, podUploadedAt: true,
        unloadingEndTime: true, deliveryLocation: true,
        vehicle: { select: { plateNumber: true } }, driver: { select: { firstName: true, lastName: true } } },
    });
    const withPod = trips.filter(t => t.podUrl);
    const withoutPod = trips.filter(t => !t.podUrl);
    const aging = withoutPod.map(t => {
      const completedAt = t.unloadingEndTime || t.tripDate;
      const daysAgo = Math.round((Date.now() - new Date(completedAt).getTime()) / 86400000);
      return { tripNumber: t.tripNumber, tripDate: t.tripDate, deliveryLocation: t.deliveryLocation,
        vehicle: (t.vehicle as any)?.plateNumber, driver: `${(t.driver as any)?.firstName || ''} ${(t.driver as any)?.lastName || ''}`.trim(),
        daysWithoutPod: daysAgo };
    }).sort((a, b) => b.daysWithoutPod - a.daysWithoutPod);
    return res.json({ total: trips.length, withPod: withPod.length, withoutPod: withoutPod.length,
      podRate: trips.length > 0 ? Number(((withPod.length / trips.length) * 100).toFixed(1)) : 0,
      aging });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Operational: Delayed trips
router.get('/delayed-trips', async (req: AuthRequest, res: Response) => {
  try {
    const delayed = await prisma.trip.findMany({
      where: { status: { in: ['dispatched', 'loading', 'in_transit', 'delivering'] } },
      select: { tripNumber: true, status: true, tripDate: true, dispatchedAt: true, departureTime: true,
        pickupLocation: true, deliveryLocation: true,
        vehicle: { select: { plateNumber: true } }, driver: { select: { firstName: true, lastName: true } } },
      orderBy: { tripDate: 'asc' },
    });
    const result = delayed.map(t => {
      const hoursInStatus = t.dispatchedAt ? Math.round((Date.now() - new Date(t.dispatchedAt).getTime()) / 3600000) : 0;
      return { ...t, vehicle: (t.vehicle as any)?.plateNumber, driver: `${(t.driver as any)?.firstName || ''} ${(t.driver as any)?.lastName || ''}`.trim(),
        hoursInStatus };
    });
    return res.json({ trips: result, count: result.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Operational: Vehicle swap history
router.get('/vehicle-swap-history', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.swappedAt = {}; if (from) where.swappedAt.gte = new Date(from); if (to) where.swappedAt.lte = new Date(to); }
    const swaps = await prisma.vehicleSwapLog.findMany({
      where, orderBy: { swappedAt: 'desc' }, take: 100,
      include: { trip: { select: { tripNumber: true } } },
    });
    const vehicleIds = [...new Set(swaps.flatMap(s => [s.fromVehicleId, s.toVehicleId]))];
    const vehicles = await prisma.vehicle.findMany({ where: { id: { in: vehicleIds } }, select: { id: true, plateNumber: true } });
    const vMap = Object.fromEntries(vehicles.map(v => [v.id, v.plateNumber]));
    const result = swaps.map(s => ({
      ...s, fromPlate: vMap[s.fromVehicleId] || s.fromVehicleId, toPlate: vMap[s.toVehicleId] || s.toVehicleId,
      tripNumber: s.trip?.tripNumber,
    }));
    return res.json({ swaps: result, count: result.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Financial: Cashier daily report
router.get('/cashier-daily', async (req: AuthRequest, res: Response) => {
  try {
    const { date, cashierId } = req.query as any;
    const sessionDate = date || new Date().toISOString().split('T')[0];
    const where: any = { sessionDate };
    if (cashierId) where.cashierId = cashierId;
    const sessions = await prisma.cashierSession.findMany({
      where,
      include: { cashier: { select: { name: true, location: true } } },
    });
    return res.json({ sessions, date: sessionDate });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Financial: Cash flow
router.get('/cash-flow', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const transactions = await prisma.cashTransaction.findMany({
      where, select: { type: true, category: true, amount: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    const byCategory: any = {};
    let totalIn = 0, totalOut = 0;
    for (const t of transactions) {
      if (t.type === 'in') totalIn += t.amount;
      else totalOut += t.amount;
      const key = `${t.type}_${t.category}`;
      if (!byCategory[key]) byCategory[key] = { type: t.type, category: t.category, amount: 0, count: 0 };
      byCategory[key].amount += t.amount;
      byCategory[key].count++;
    }
    // Daily flow
    const daily: any = {};
    for (const t of transactions) {
      const d = new Date(t.createdAt).toISOString().slice(0, 10);
      if (!daily[d]) daily[d] = { date: d, inflow: 0, outflow: 0 };
      if (t.type === 'in') daily[d].inflow += t.amount;
      else daily[d].outflow += t.amount;
    }
    return res.json({ totalIn, totalOut, netFlow: totalIn - totalOut,
      byCategory: Object.values(byCategory),
      daily: Object.values(daily).sort((a: any, b: any) => a.date.localeCompare(b.date)) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Financial: Settlement summary
router.get('/settlement-summary', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const settlements = await prisma.settlement.findMany({
      where, select: { settlementNumber: true, status: true, grossAmount: true, totalPenalties: true,
        totalPerDiem: true, netAmount: true, totalDeliveredTons: true,
        order: { select: { orderNumber: true, customer: { select: { companyName: true } } } } },
    });
    const byStatus: any = {};
    for (const s of settlements) {
      if (!byStatus[s.status]) byStatus[s.status] = { status: s.status, count: 0, totalAmount: 0 };
      byStatus[s.status].count++;
      byStatus[s.status].totalAmount += s.netAmount;
    }
    return res.json({ settlements, byStatus: Object.values(byStatus), total: settlements.length,
      totalGross: settlements.reduce((s, st) => s + st.grossAmount, 0),
      totalNet: settlements.reduce((s, st) => s + st.netAmount, 0),
      totalPenalties: settlements.reduce((s, st) => s + st.totalPenalties, 0) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Financial: Receivables aging
router.get('/receivables-aging', async (req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const invoices = await prisma.invoice.findMany({
      where: { status: { in: ['sent', 'overdue', 'unpaid', 'partial'] }, balanceDue: { gt: 0 } },
      select: { invoiceNumber: true, dueDate: true, totalAmount: true, balanceDue: true, status: true,
        customer: { select: { companyName: true } } },
      orderBy: { dueDate: 'asc' },
    });
    const aging = { current: 0, days30: 0, days60: 0, days90: 0, over90: 0 };
    const agingDetail = invoices.map(inv => {
      const daysOverdue = inv.dueDate ? Math.max(0, Math.round((now.getTime() - new Date(inv.dueDate).getTime()) / 86400000)) : 0;
      if (daysOverdue <= 0) aging.current += inv.balanceDue;
      else if (daysOverdue <= 30) aging.days30 += inv.balanceDue;
      else if (daysOverdue <= 60) aging.days60 += inv.balanceDue;
      else if (daysOverdue <= 90) aging.days90 += inv.balanceDue;
      else aging.over90 += inv.balanceDue;
      return { ...inv, customer: (inv.customer as any)?.companyName, daysOverdue };
    });
    return res.json({ aging, invoices: agingDetail, totalOutstanding: invoices.reduce((s, i) => s + i.balanceDue, 0) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Control: Penalty summary
router.get('/penalty-summary', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const penalties = await prisma.orderPenalty.findMany({
      where, select: { type: true, amount: true, status: true,
        order: { select: { orderNumber: true } }, trip: { select: { tripNumber: true } } },
    });
    const byType: any = {};
    const byStatus: any = {};
    for (const p of penalties) {
      if (!byType[p.type]) byType[p.type] = { type: p.type, count: 0, totalAmount: 0 };
      byType[p.type].count++; byType[p.type].totalAmount += p.amount;
      if (!byStatus[p.status]) byStatus[p.status] = { status: p.status, count: 0, totalAmount: 0 };
      byStatus[p.status].count++; byStatus[p.status].totalAmount += p.amount;
    }
    return res.json({ byType: Object.values(byType), byStatus: Object.values(byStatus),
      total: penalties.length, totalAmount: penalties.reduce((s, p) => s + p.amount, 0) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Control: Approval turnaround
router.get('/approval-turnaround', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const requests = await prisma.approvalRequest.findMany({
      where, select: { type: true, status: true, createdAt: true, updatedAt: true, priority: true },
    });
    const byType: any = {};
    for (const r of requests) {
      if (!byType[r.type]) byType[r.type] = { type: r.type, total: 0, approved: 0, rejected: 0, pending: 0, avgHours: 0, totalHours: 0 };
      byType[r.type].total++;
      if (r.status === 'approved') { byType[r.type].approved++; byType[r.type].totalHours += (new Date(r.updatedAt).getTime() - new Date(r.createdAt).getTime()) / 3600000; }
      else if (r.status === 'rejected') byType[r.type].rejected++;
      else byType[r.type].pending++;
    }
    for (const t of Object.values(byType) as any[]) {
      t.avgHours = t.approved > 0 ? Number((t.totalHours / t.approved).toFixed(1)) : 0;
      delete t.totalHours;
    }
    return res.json({ byType: Object.values(byType), total: requests.length,
      pending: requests.filter(r => r.status === 'pending').length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Control: Alert resolution
router.get('/alert-resolution', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const alerts = await prisma.alert.findMany({
      where, select: { type: true, severity: true, isResolved: true, createdAt: true, resolvedAt: true },
    });
    const byType: any = {};
    for (const a of alerts) {
      if (!byType[a.type]) byType[a.type] = { type: a.type, total: 0, resolved: 0, unresolved: 0, avgResolutionHours: 0, totalHours: 0 };
      byType[a.type].total++;
      if (a.isResolved && a.resolvedAt) {
        byType[a.type].resolved++;
        byType[a.type].totalHours += (new Date(a.resolvedAt).getTime() - new Date(a.createdAt).getTime()) / 3600000;
      } else { byType[a.type].unresolved++; }
    }
    for (const t of Object.values(byType) as any[]) {
      t.avgResolutionHours = t.resolved > 0 ? Number((t.totalHours / t.resolved).toFixed(1)) : 0;
      delete t.totalHours;
    }
    return res.json({ byType: Object.values(byType), total: alerts.length,
      resolved: alerts.filter(a => a.isResolved).length, unresolved: alerts.filter(a => !a.isResolved).length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Control: Compliance status
router.get('/compliance-status', async (req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const in30 = new Date(now.getTime() + 30 * 86400000);
    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      select: { plateNumber: true, insuranceExpiry: true, inspectionExpiry: true, permitExpiry: true,
        complianceLocked: true, lockReason: true },
    });
    let expired = 0, expiringSoon = 0, compliant = 0, locked = 0;
    const details = vehicles.map(v => {
      const issues: string[] = [];
      const isExpired = (d: any) => d && new Date(d) < now;
      const isExpiring = (d: any) => d && new Date(d) >= now && new Date(d) <= in30;
      if (isExpired(v.insuranceExpiry)) issues.push('insurance expired');
      else if (isExpiring(v.insuranceExpiry)) issues.push('insurance expiring');
      if (isExpired(v.inspectionExpiry)) issues.push('inspection expired');
      else if (isExpiring(v.inspectionExpiry)) issues.push('inspection expiring');
      if (isExpired(v.permitExpiry)) issues.push('permit expired');
      else if (isExpiring(v.permitExpiry)) issues.push('permit expiring');
      if (issues.some(i => i.includes('expired'))) expired++;
      else if (issues.length > 0) expiringSoon++;
      else compliant++;
      if ((v as any).complianceLocked) locked++;
      return { plateNumber: v.plateNumber, locked: (v as any).complianceLocked, lockReason: (v as any).lockReason, issues };
    }).filter(v => v.issues.length > 0 || v.locked);
    return res.json({ summary: { total: vehicles.length, expired, expiringSoon, compliant, locked }, vehicles: details });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ────────────────────────────────────────────────────────────────────────
// Monthly / Weekly / Quarterly / Custom Procurement Report
// Returns the 6-section structured report.
// Query: ?period=weekly|monthly|quarterly|custom & ?from=&to=
// ────────────────────────────────────────────────────────────────────────
router.get('/procurement-summary', async (req: AuthRequest, res: Response) => {
  try {
    const { period = 'monthly' } = req.query as any;
    let { from, to } = req.query as any;
    const now = new Date();
    if (!from || !to) {
      const end = new Date(now);
      const start = new Date(now);
      if (period === 'weekly') start.setDate(start.getDate() - 7);
      else if (period === 'quarterly') start.setMonth(start.getMonth() - 3);
      else /* monthly */ start.setMonth(start.getMonth() - 1);
      from = start.toISOString();
      to = end.toISOString();
    }
    const fromD = new Date(from);
    const toD = new Date(to);
    const inRange = { gte: fromD, lte: toD };

    // ── 1. Executive Summary ─────────────────────────────────────────
    const posIssued = await (prisma as any).purchaseOrder.findMany({
      where: { createdAt: inRange },
      include: { supplier: { select: { name: true } } },
    });
    const totalSpend = posIssued.reduce((s: number, p: any) => s + (p.totalAmount || 0), 0);
    const ordersByStatus: Record<string, number> = {};
    for (const p of posIssued) ordersByStatus[p.status] = (ordersByStatus[p.status] || 0) + 1;
    const topSpendItems = [...posIssued]
      .sort((a: any, b: any) => (b.totalAmount || 0) - (a.totalAmount || 0))
      .slice(0, 5)
      .map((p: any) => ({ poNumber: p.poNumber, supplier: p.supplier?.name, amount: p.totalAmount }));

    // ── 2. Inventory & Stock Status (by reportGroup) ────────────────
    const inventory = await (prisma as any).inventory.findMany({ where: { isActive: true } });
    const txInPeriod = await (prisma as any).inventoryTransaction.findMany({
      where: { createdAt: inRange },
    });
    const groups: Record<string, any> = {};
    for (const item of inventory) {
      const g = item.reportGroup || 'unclassified';
      if (!groups[g]) {
        groups[g] = {
          reportGroup: g,
          itemCount: 0,
          openingQty: 0, openingValue: 0,
          receivedQty: 0, receivedValue: 0,
          issuedQty: 0, issuedValue: 0,
          closingQty: 0, closingValue: 0,
          status: 'healthy',
          items: [],
        };
      }
      const grp = groups[g];
      grp.itemCount += 1;
      grp.closingQty += item.quantityInStock;
      grp.closingValue += item.totalValue;
      const itemRcv = txInPeriod.filter((t: any) => t.inventoryId === item.id && t.type === 'in')
        .reduce((s: any, t: any) => ({ q: s.q + t.quantity, v: s.v + t.totalCost }), { q: 0, v: 0 });
      grp.receivedQty += itemRcv.q;
      grp.receivedValue += itemRcv.v;
      const itemIss = txInPeriod.filter((t: any) => t.inventoryId === item.id && t.type === 'out')
        .reduce((s: any, t: any) => ({ q: s.q + t.quantity, v: s.v + t.totalCost }), { q: 0, v: 0 });
      grp.issuedQty += itemIss.q;
      grp.issuedValue += itemIss.v;
      grp.openingQty += item.quantityInStock - itemRcv.q + itemIss.q;
      grp.openingValue += item.totalValue - itemRcv.v + itemIss.v;
      const minLevel = item.minimumStock || 0;
      const reorderPt = item.reorderPoint || minLevel;
      let level: 'healthy' | 'reorder' | 'critical' = 'healthy';
      if (item.quantityInStock <= minLevel * 0.5) level = 'critical';
      else if (item.quantityInStock <= reorderPt) level = 'reorder';
      grp.items.push({
        id: item.id, partName: item.partName, partNumber: item.partNumber,
        unit: item.unit, qtyInStock: item.quantityInStock, totalValue: item.totalValue,
        minimumStock: item.minimumStock, reorderPoint: item.reorderPoint,
        level, lastPurchasePrice: item.lastPurchasePrice,
      });
      const order = { healthy: 0, reorder: 1, critical: 2 } as any;
      if (order[level] > order[grp.status]) grp.status = level;
    }
    const stockStatus = Object.values(groups);

    // ── 3. Vendor & Lead-Time Performance ───────────────────────────
    const suppliersRaw = await (prisma as any).supplier.findMany({
      where: { status: 'active' },
      include: {
        purchaseOrders: {
          where: { createdAt: inRange },
        },
      },
    });
    const vendorPerf = suppliersRaw.map((s: any) => {
      const periodPOs = s.purchaseOrders;
      const periodSpend = periodPOs.reduce((sum: number, p: any) => sum + (p.totalAmount || 0), 0);
      return {
        supplierId: s.id,
        supplierName: s.name,
        suppliedCategory: s.suppliedCategory,
        periodSpend,
        totalSpendAllTime: s.totalSpend || 0,
        avgLeadTimeDays: s.avgLeadTimeDays,
        qualityPassRate: s.qualityPassRate,
        rating: s.rating,
        ordersCount: periodPOs.length,
      };
    });

    // ── 4. Pending Requisitions & Pipeline ──────────────────────────
    const openPRs = await (prisma as any).purchaseRequest.findMany({
      where: { status: { in: ['draft', 'pending', 'approved', 'quotation'] } },
      orderBy: { createdAt: 'asc' },
    });
    const pendingPRApprovals = openPRs.filter((p: any) => p.status === 'pending');
    const goodsInTransit = await (prisma as any).purchaseOrder.findMany({
      where: { status: 'shipped' },
      include: { supplier: { select: { name: true } }, purchaseRequest: { select: { requestNumber: true } } },
      orderBy: { shippedAt: 'asc' },
    });
    const pendingPaymentApprovals = await prisma.paymentRequest.findMany({
      where: { status: 'submitted', referenceType: 'po' },
      orderBy: { createdAt: 'asc' },
    });

    // ── 5. Financial Reconciliation ─────────────────────────────────
    const apOutstanding = await prisma.paymentRequest.findMany({
      where: { status: { in: ['submitted', 'approved'] }, referenceType: 'po' },
    });
    const apTotal = apOutstanding.reduce((s, r) => s + (r.amount - (r.paidAmount || 0)), 0);
    const supplierBalances = await (prisma as any).supplier.findMany({
      where: { currentBalance: { gt: 0 } },
      select: { id: true, name: true, currentBalance: true, creditLimit: true, creditTermsDays: true },
      orderBy: { currentBalance: 'desc' },
    });

    // ── 6. Action Plan & Risk Mitigation (auto-detected) ────────────
    const risks: Array<{ category: string; severity: 'high' | 'medium' | 'low'; message: string }> = [];
    for (const grp of stockStatus as any[]) {
      const critical = grp.items.filter((i: any) => i.level === 'critical');
      const reorder = grp.items.filter((i: any) => i.level === 'reorder');
      if (critical.length > 0) risks.push({
        category: 'Stock Critical',
        severity: 'high',
        message: `${critical.length} item(s) in "${grp.reportGroup}" critically low: ${critical.slice(0, 3).map((i: any) => i.partName).join(', ')}${critical.length > 3 ? '…' : ''}`,
      });
      else if (reorder.length > 0) risks.push({
        category: 'Reorder Required',
        severity: 'medium',
        message: `${reorder.length} item(s) in "${grp.reportGroup}" hit reorder point.`,
      });
    }
    const supplierCategories: Record<string, Set<string>> = {};
    for (const s of suppliersRaw as any[]) {
      const cat = s.suppliedCategory || 'general';
      if (!supplierCategories[cat]) supplierCategories[cat] = new Set();
      supplierCategories[cat].add(s.id);
    }
    for (const [cat, ids] of Object.entries(supplierCategories)) {
      if (ids.size <= 1) {
        risks.push({
          category: 'Single-Source Risk',
          severity: 'medium',
          message: `Category "${cat}" has only ${ids.size} active supplier(s). Identify backup vendors.`,
        });
      }
    }
    for (const s of suppliersRaw as any[]) {
      if (s.qualityPassRate !== null && s.qualityPassRate < 80) {
        risks.push({
          category: 'Quality',
          severity: 'high',
          message: `Supplier "${s.name}" has only ${(s.qualityPassRate as number).toFixed(0)}% inspection pass rate.`,
        });
      }
      if (s.avgLeadTimeDays && s.avgLeadTimeDays > 30) {
        risks.push({
          category: 'Lead Time',
          severity: 'medium',
          message: `Supplier "${s.name}" averages ${(s.avgLeadTimeDays as number).toFixed(1)} days lead time.`,
        });
      }
    }
    for (const po of goodsInTransit as any[]) {
      if (po.shippedAt && po.expectedDelivery) {
        const overdueDays = (Date.now() - new Date(po.expectedDelivery).getTime()) / 86400000;
        if (overdueDays > 0) {
          risks.push({
            category: 'Delivery Overdue',
            severity: 'high',
            message: `PO ${po.poNumber} from ${po.supplier?.name} is ${overdueDays.toFixed(0)} days overdue.`,
          });
        }
      }
    }

    const managerNote = await (prisma as any).procurementReportNote.findFirst({
      where: { period, fromDate: fromD, toDate: toD },
    });

    // Internal approval time (PR → quote selected = PO issued)
    const approvedPRsInPeriod = await (prisma as any).purchaseRequest.findMany({
      where: { createdAt: inRange, status: { in: ['ordered', 'received'] } },
      include: { quotations: { where: { status: 'selected' } } },
    });
    let totalApprovalDays = 0; let approvalCount = 0;
    for (const pr of approvedPRsInPeriod) {
      const sel = pr.quotations[0];
      if (sel) {
        const days = (new Date(sel.createdAt).getTime() - new Date(pr.createdAt).getTime()) / 86400000;
        if (days >= 0) { totalApprovalDays += days; approvalCount++; }
      }
    }
    const avgInternalApprovalDays = approvalCount ? totalApprovalDays / approvalCount : null;

    return res.json({
      period, from: fromD, to: toD,
      executiveSummary: {
        totalSpend,
        ordersIssued: posIssued.length,
        ordersByStatus,
        topSpendItems,
        avgInternalApprovalDays,
      },
      stockStatus,
      vendorPerformance: vendorPerf,
      pipeline: {
        openPurchaseRequests: openPRs.map((p: any) => ({
          id: p.id, requestNumber: p.requestNumber, status: p.status,
          isEmergency: p.isEmergency, department: p.department,
          createdAt: p.createdAt,
          ageingDays: Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000),
        })),
        pendingPRApprovals: pendingPRApprovals.length,
        pendingPaymentApprovals: pendingPaymentApprovals.length,
        goodsInTransit: goodsInTransit.map((p: any) => ({
          poNumber: p.poNumber, supplier: p.supplier?.name,
          shippedAt: p.shippedAt, expectedDelivery: p.expectedDelivery,
          daysInTransit: p.shippedAt ? Math.floor((Date.now() - new Date(p.shippedAt).getTime()) / 86400000) : null,
        })),
      },
      financialReconciliation: {
        accountsPayableTotal: apTotal,
        accountsPayableCount: apOutstanding.length,
        supplierBalances,
      },
      actionPlan: {
        autoRisks: risks,
        managerNote: managerNote || null,
      },
    });
  } catch (e: any) {
    console.error('procurement-summary error', e);
    return res.status(500).json({ error: e.message });
  }
});

// ── Procurement Report Manager's Note (hybrid action plan) ─────────────
router.get('/procurement-note', async (req: AuthRequest, res: Response) => {
  try {
    const { period = 'monthly', from, to } = req.query as any;
    if (!from || !to) return res.json({ note: null });
    const note = await (prisma as any).procurementReportNote.findFirst({
      where: { period, fromDate: new Date(from), toDate: new Date(to) },
    });
    return res.json({ note: note || null });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/procurement-note', async (req: AuthRequest, res: Response) => {
  try {
    const { period, from, to, keyAchievement, marketAnalysisNote, strategicSourcingNote, generalNotes } = req.body as any;
    if (!period || !from || !to) return res.status(400).json({ error: 'period, from, to required' });
    const fromD = new Date(from);
    const toD = new Date(to);
    const existing = await (prisma as any).procurementReportNote.findFirst({
      where: { period, fromDate: fromD, toDate: toD },
    });
    let note;
    if (existing) {
      note = await (prisma as any).procurementReportNote.update({
        where: { id: existing.id },
        data: {
          keyAchievement: keyAchievement ?? null,
          marketAnalysisNote: marketAnalysisNote ?? null,
          strategicSourcingNote: strategicSourcingNote ?? null,
          generalNotes: generalNotes ?? null,
          authorId: req.user?.id || null,
        },
      });
    } else {
      note = await (prisma as any).procurementReportNote.create({
        data: {
          period, fromDate: fromD, toDate: toD,
          keyAchievement: keyAchievement ?? null,
          marketAnalysisNote: marketAnalysisNote ?? null,
          strategicSourcingNote: strategicSourcingNote ?? null,
          generalNotes: generalNotes ?? null,
          authorId: req.user?.id || null,
        },
      });
    }
    return res.json({ note });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
