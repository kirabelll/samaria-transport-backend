import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// Profit per vehicle
router.get('/vehicles', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from as string);
    if (to) dateFilter.lte = new Date(to as string);
    const tripWhere: any = { status: 'completed' };
    if (from || to) tripWhere.tripDate = dateFilter;

    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      select: {
        id: true, plateNumber: true, category: true, make: true, model: true,
        depreciation: { select: { monthlyDepreciation: true } },
      }
    });

    const results = await Promise.all(vehicles.map(async (v) => {
      // Revenue from trips
      const trips = await prisma.trip.findMany({
        where: { vehicleId: v.id, ...tripWhere },
        select: { revenue: true, fuelCost: true, shortageDeduction: true, driverAdvanceGiven: true },
      });
      const revenue = trips.reduce((s, t) => s + (t.revenue || 0), 0);
      const fuelCost = trips.reduce((s, t) => s + (t.fuelCost || 0), 0);

      // Fuel logs
      const fuelWhere: any = { vehicleId: v.id };
      if (from || to) fuelWhere.date = dateFilter;
      const fuelLogs = await prisma.fuelLog.findMany({ where: fuelWhere, select: { totalCost: true } });
      const totalFuel = fuelLogs.reduce((s, f) => s + f.totalCost, 0) || fuelCost;

      // Maintenance cost (work orders)
      const woWhere: any = { vehicleId: v.id, status: 'completed' };
      if (from || to) woWhere.endTime = dateFilter;
      const workOrders = await prisma.workOrder.findMany({ where: woWhere, select: { totalCost: true } });
      const maintenanceCost = workOrders.reduce((s, w) => s + (w.totalCost || 0), 0);

      // Spare parts cost
      const spWhere: any = { workOrder: { vehicleId: v.id }, status: 'issued' };
      const spareParts = await prisma.sparePartRequest.findMany({ where: spWhere, select: { totalCost: true } });
      const partsCost = spareParts.reduce((s, sp) => s + (sp.totalCost || 0), 0);

      // Depreciation
      const monthlyDepr = v.depreciation?.monthlyDepreciation || 0;
      const months = from && to ? Math.max(1, Math.ceil((new Date(to as string).getTime() - new Date(from as string).getTime()) / (30 * 86400000))) : 1;
      const depreciationCost = monthlyDepr * months;

      // Driver cost estimate (advances from trips)
      const driverCost = trips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);

      const totalCost = totalFuel + maintenanceCost + partsCost + depreciationCost + driverCost;
      const netProfit = revenue - totalCost;

      return {
        vehicleId: v.id, plateNumber: v.plateNumber, category: v.category,
        make: v.make, model: v.model, tripCount: trips.length,
        revenue, fuelCost: totalFuel, maintenanceCost, partsCost,
        depreciationCost: Math.round(depreciationCost), driverCost,
        totalCost, netProfit, margin: revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : '0.0',
      };
    }));

    results.sort((a, b) => b.netProfit - a.netProfit);

    const totals = results.reduce((acc, r) => ({
      revenue: acc.revenue + r.revenue,
      totalCost: acc.totalCost + r.totalCost,
      netProfit: acc.netProfit + r.netProfit,
      fuelCost: acc.fuelCost + r.fuelCost,
      maintenanceCost: acc.maintenanceCost + r.maintenanceCost,
    }), { revenue: 0, totalCost: 0, netProfit: 0, fuelCost: 0, maintenanceCost: 0 });

    return res.json({ vehicles: results, totals });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Profit by category
router.get('/by-category', async (req: AuthRequest, res: Response) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      select: { id: true, category: true },
    });

    const trips = await prisma.trip.findMany({
      where: { status: 'completed' },
      select: { vehicleId: true, revenue: true, fuelCost: true },
    });

    const catMap: any = {};
    for (const v of vehicles) {
      if (!catMap[v.category]) catMap[v.category] = { category: v.category, vehicleCount: 0, revenue: 0, fuelCost: 0, tripCount: 0 };
      catMap[v.category].vehicleCount++;
    }
    for (const t of trips) {
      const v = vehicles.find(v => v.id === t.vehicleId);
      if (v && catMap[v.category]) {
        catMap[v.category].revenue += t.revenue || 0;
        catMap[v.category].fuelCost += t.fuelCost || 0;
        catMap[v.category].tripCount++;
      }
    }

    return res.json({ categories: Object.values(catMap) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Single vehicle detailed profitability
router.get('/vehicles/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const vehicle = await prisma.vehicle.findUnique({
      where: { id },
      include: {
        assignedDriver: { select: { firstName: true, lastName: true } },
        depreciation: true,
      },
    });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const trips = await prisma.trip.findMany({
      where: { vehicleId: id, status: 'completed' },
      orderBy: { tripDate: 'desc' }, take: 50,
      select: { id: true, tripNumber: true, tripDate: true, revenue: true, fuelCost: true, shortage: true, shortageDeduction: true, driverAdvanceGiven: true },
    });

    const fuelLogs = await prisma.fuelLog.findMany({
      where: { vehicleId: id }, orderBy: { date: 'desc' }, take: 20,
      select: { date: true, liters: true, totalCost: true },
    });

    const workOrders = await prisma.workOrder.findMany({
      where: { vehicleId: id }, orderBy: { createdAt: 'desc' }, take: 20,
      select: { workOrderNumber: true, type: true, totalCost: true, status: true, createdAt: true },
    });

    return res.json({ vehicle, trips, fuelLogs, workOrders });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Profitability by route (#12)
router.get('/by-route', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const where: any = { status: 'completed' };
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from as string); if (to) where.tripDate.lte = new Date(to as string); }

    const trips = await prisma.trip.findMany({
      where, select: {
        pickupLocation: true, deliveryLocation: true, revenue: true,
        fuelCost: true, shortage: true, shortageDeduction: true,
        driverAdvanceGiven: true, deliveredQuantityTons: true,
      },
    });

    const routeMap: any = {};
    for (const t of trips) {
      const key = `${t.pickupLocation} → ${t.deliveryLocation}`;
      if (!routeMap[key]) routeMap[key] = { route: key, trips: 0, totalTonnage: 0, totalRevenue: 0, totalFuel: 0, totalShortage: 0, totalDriverCost: 0 };
      routeMap[key].trips++;
      routeMap[key].totalTonnage += t.deliveredQuantityTons || 0;
      routeMap[key].totalRevenue += t.revenue || 0;
      routeMap[key].totalFuel += t.fuelCost || 0;
      routeMap[key].totalShortage += t.shortageDeduction || 0;
      routeMap[key].totalDriverCost += t.driverAdvanceGiven || 0;
    }

    const routes = Object.values(routeMap).map((r: any) => ({
      ...r,
      totalCost: r.totalFuel + r.totalDriverCost,
      netProfit: r.totalRevenue - r.totalFuel - r.totalDriverCost,
      margin: r.totalRevenue > 0 ? Number(((r.totalRevenue - r.totalFuel - r.totalDriverCost) / r.totalRevenue * 100).toFixed(1)) : 0,
      avgRevenuePerTrip: r.trips > 0 ? Math.round(r.totalRevenue / r.trips) : 0,
      avgRevenuePerTon: r.totalTonnage > 0 ? Math.round(r.totalRevenue / r.totalTonnage) : 0,
    })).sort((a: any, b: any) => b.netProfit - a.netProfit);

    return res.json({ routes });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Profitability by customer (#12)
router.get('/by-customer', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const where: any = { status: 'completed' };
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from as string); if (to) where.tripDate.lte = new Date(to as string); }

    const trips = await prisma.trip.findMany({
      where, select: {
        customerId: true, revenue: true, fuelCost: true,
        driverAdvanceGiven: true, deliveredQuantityTons: true, shortage: true,
        customer: { select: { companyName: true, paymentType: true } },
      },
    });

    const custMap: any = {};
    for (const t of trips) {
      const cid = t.customerId || 'unknown';
      if (!custMap[cid]) custMap[cid] = { customerId: cid, name: t.customer?.companyName || 'Walk-in', paymentType: t.customer?.paymentType || 'cash', trips: 0, totalTonnage: 0, totalRevenue: 0, totalFuel: 0, totalDriverCost: 0, totalShortage: 0 };
      custMap[cid].trips++;
      custMap[cid].totalTonnage += t.deliveredQuantityTons || 0;
      custMap[cid].totalRevenue += t.revenue || 0;
      custMap[cid].totalFuel += t.fuelCost || 0;
      custMap[cid].totalDriverCost += t.driverAdvanceGiven || 0;
      custMap[cid].totalShortage += t.shortage || 0;
    }

    // Get outstanding invoices per customer
    const invoices = await prisma.invoice.findMany({
      where: { status: { in: ['unpaid', 'partial', 'overdue'] } },
      select: { customerId: true, balanceDue: true },
    });
    const outstandingMap: any = {};
    for (const inv of invoices) {
      outstandingMap[inv.customerId] = (outstandingMap[inv.customerId] || 0) + (inv.balanceDue || 0);
    }

    const customers = Object.values(custMap).map((c: any) => ({
      ...c,
      totalCost: c.totalFuel + c.totalDriverCost,
      netProfit: c.totalRevenue - c.totalFuel - c.totalDriverCost,
      margin: c.totalRevenue > 0 ? Number(((c.totalRevenue - c.totalFuel - c.totalDriverCost) / c.totalRevenue * 100).toFixed(1)) : 0,
      outstanding: outstandingMap[c.customerId] || 0,
    })).sort((a: any, b: any) => b.netProfit - a.netProfit);

    return res.json({ customers });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Profitability by cargo type (#12)
router.get('/by-cargo-type', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const where: any = { status: 'completed' };
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from as string); if (to) where.tripDate.lte = new Date(to as string); }

    const trips = await prisma.trip.findMany({
      where, select: { orderType: true, revenue: true, fuelCost: true, driverAdvanceGiven: true, deliveredQuantityTons: true },
    });

    const typeMap: any = {};
    for (const t of trips) {
      const type = t.orderType || 'other';
      if (!typeMap[type]) typeMap[type] = { cargoType: type, trips: 0, totalTonnage: 0, totalRevenue: 0, totalFuel: 0, totalDriverCost: 0 };
      typeMap[type].trips++;
      typeMap[type].totalTonnage += t.deliveredQuantityTons || 0;
      typeMap[type].totalRevenue += t.revenue || 0;
      typeMap[type].totalFuel += t.fuelCost || 0;
      typeMap[type].totalDriverCost += t.driverAdvanceGiven || 0;
    }

    const cargoTypes = Object.values(typeMap).map((c: any) => ({
      ...c,
      totalCost: c.totalFuel + c.totalDriverCost,
      netProfit: c.totalRevenue - c.totalFuel - c.totalDriverCost,
      margin: c.totalRevenue > 0 ? Number(((c.totalRevenue - c.totalFuel - c.totalDriverCost) / c.totalRevenue * 100).toFixed(1)) : 0,
      avgRevenuePerTon: c.totalTonnage > 0 ? Math.round(c.totalRevenue / c.totalTonnage) : 0,
    })).sort((a: any, b: any) => b.totalRevenue - a.totalRevenue);

    return res.json({ cargoTypes });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ─── PHASE 8: ENHANCED PROFITABILITY ───────────────────────

// Profit per order (including penalties & per diem)
router.get('/by-order', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, customerId } = req.query;
    const orderWhere: any = {};
    if (customerId) orderWhere.customerId = customerId;
    if (from || to) {
      orderWhere.orderDate = {};
      if (from) orderWhere.orderDate.gte = new Date(from as string);
      if (to) orderWhere.orderDate.lte = new Date(to as string);
    }

    const orders = await prisma.customerOrder.findMany({
      where: orderWhere,
      select: {
        id: true, orderNumber: true, orderDate: true, orderType: true,
        quantity: true, ratePerTon: true, totalAmount: true, status: true,
        route: true, itemProduct: true, totalDelivered: true, totalTrips: true,
        customer: { select: { companyName: true } },
      },
    });

    const results = await Promise.all(orders.map(async (o) => {
      // Get trips for this order
      const trips = await prisma.trip.findMany({
        where: { orderId: o.id, status: 'completed' },
        select: { revenue: true, fuelCost: true, driverAdvanceGiven: true, totalTripCost: true,
                  deliveredQuantityTons: true, shortage: true, shortageDeduction: true },
      });
      const tripRevenue = trips.reduce((s, t) => s + (t.revenue || 0), 0);
      const tripFuel = trips.reduce((s, t) => s + (t.fuelCost || 0), 0);
      const tripDriverCost = trips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);
      const tripTotalCost = trips.reduce((s, t) => s + (t.totalTripCost || 0), 0);
      const deliveredTons = trips.reduce((s, t) => s + (t.deliveredQuantityTons || 0), 0);
      const totalShortage = trips.reduce((s, t) => s + (t.shortage || 0), 0);
      const shortageDeductions = trips.reduce((s, t) => s + (t.shortageDeduction || 0), 0);

      // Get penalties
      const penalties = await prisma.orderPenalty.findMany({
        where: { orderId: o.id, status: { in: ['approved', 'applied'] } },
        select: { type: true, amount: true },
      });
      const totalPenalties = penalties.reduce((s, p) => s + (p.amount || 0), 0);

      // Get settlement if exists
      const settlement = await prisma.settlement.findFirst({
        where: { orderId: o.id },
        select: { netAmount: true, totalPerDiem: true, totalPenalties: true, status: true },
      });

      const totalCost = tripTotalCost > 0 ? tripTotalCost : (tripFuel + tripDriverCost);
      const netProfit = tripRevenue - totalCost - totalPenalties;

      return {
        orderId: o.id, orderNumber: o.orderNumber, orderDate: o.orderDate,
        customer: (o.customer as any)?.companyName || '-', orderType: o.orderType,
        route: o.route || '-', itemProduct: o.itemProduct || '-',
        orderedQty: o.quantity, deliveredTons, totalShortage,
        tripCount: trips.length, ratePerTon: o.ratePerTon || 0,
        revenue: tripRevenue, fuelCost: tripFuel, driverCost: tripDriverCost,
        totalCost, totalPenalties, shortageDeductions,
        perDiem: settlement?.totalPerDiem || 0,
        netProfit,
        margin: tripRevenue > 0 ? Number(((netProfit / tripRevenue) * 100).toFixed(1)) : 0,
        settlementStatus: settlement?.status || 'none',
        status: o.status,
      };
    }));

    results.sort((a, b) => b.revenue - a.revenue);

    const totals = results.reduce((acc, r) => ({
      revenue: acc.revenue + r.revenue, totalCost: acc.totalCost + r.totalCost,
      netProfit: acc.netProfit + r.netProfit, totalPenalties: acc.totalPenalties + r.totalPenalties,
      deliveredTons: acc.deliveredTons + r.deliveredTons,
    }), { revenue: 0, totalCost: 0, netProfit: 0, totalPenalties: 0, deliveredTons: 0 });

    return res.json({ orders: results, totals, count: results.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Detailed single order profitability
router.get('/by-order/:orderId', async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const order = await prisma.customerOrder.findUnique({
      where: { id: orderId },
      include: { customer: { select: { companyName: true } } },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const trips = await prisma.trip.findMany({
      where: { orderId, status: 'completed' },
      select: {
        id: true, tripNumber: true, tripDate: true, revenue: true,
        fuelCost: true, driverAdvanceGiven: true, totalTripCost: true,
        deliveredQuantityTons: true, shortage: true, shortageDeduction: true,
        driver: { select: { firstName: true, lastName: true } },
        vehicle: { select: { plateNumber: true } },
      },
      orderBy: { tripDate: 'asc' },
    });

    const penalties = await prisma.orderPenalty.findMany({
      where: { orderId },
      select: { id: true, type: true, description: true, amount: true, status: true, tripId: true, createdAt: true },
    });

    const settlement = await prisma.settlement.findFirst({
      where: { orderId },
      include: { lines: true },
    });

    const tripDetails = trips.map(t => ({
      ...t,
      driverName: `${(t.driver as any)?.firstName || ''} ${(t.driver as any)?.lastName || ''}`.trim(),
      plateNumber: (t.vehicle as any)?.plateNumber || '-',
      cost: (t.totalTripCost || 0) > 0 ? t.totalTripCost : ((t.fuelCost || 0) + (t.driverAdvanceGiven || 0)),
      profit: (t.revenue || 0) - ((t.totalTripCost || 0) > 0 ? (t.totalTripCost || 0) : ((t.fuelCost || 0) + (t.driverAdvanceGiven || 0))),
    }));

    const totalRevenue = trips.reduce((s, t) => s + (t.revenue || 0), 0);
    const totalCost = tripDetails.reduce((s, t) => s + (t.cost || 0), 0);
    const totalPenalties = penalties.filter(p => p.status === 'approved' || p.status === 'applied').reduce((s, p) => s + p.amount, 0);

    return res.json({
      order: { ...order, customer: (order.customer as any)?.companyName },
      trips: tripDetails, penalties, settlement,
      summary: {
        totalRevenue, totalCost, totalPenalties,
        netProfit: totalRevenue - totalCost - totalPenalties,
        margin: totalRevenue > 0 ? Number(((totalRevenue - totalCost - totalPenalties) / totalRevenue * 100).toFixed(1)) : 0,
        deliveredTons: trips.reduce((s, t) => s + (t.deliveredQuantityTons || 0), 0),
        tripCount: trips.length,
      },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Profit by driver
router.get('/by-driver', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const tripWhere: any = { status: 'completed' };
    if (from || to) {
      tripWhere.tripDate = {};
      if (from) tripWhere.tripDate.gte = new Date(from as string);
      if (to) tripWhere.tripDate.lte = new Date(to as string);
    }

    const trips = await prisma.trip.findMany({
      where: tripWhere,
      select: {
        driverId: true, revenue: true, fuelCost: true, driverAdvanceGiven: true,
        totalTripCost: true, deliveredQuantityTons: true, shortage: true,
        driver: { select: { firstName: true, lastName: true } },
      },
    });

    const driverMap: any = {};
    for (const t of trips) {
      const did = t.driverId;
      if (!driverMap[did]) {
        driverMap[did] = {
          driverId: did,
          name: `${(t.driver as any)?.firstName || ''} ${(t.driver as any)?.lastName || ''}`.trim(),
          trips: 0, totalTonnage: 0, totalRevenue: 0, totalFuel: 0,
          totalAdvance: 0, totalCost: 0, totalShortage: 0,
        };
      }
      const d = driverMap[did];
      d.trips++;
      d.totalTonnage += t.deliveredQuantityTons || 0;
      d.totalRevenue += t.revenue || 0;
      d.totalFuel += t.fuelCost || 0;
      d.totalAdvance += t.driverAdvanceGiven || 0;
      d.totalShortage += t.shortage || 0;
      d.totalCost += (t.totalTripCost || 0) > 0 ? (t.totalTripCost || 0) : ((t.fuelCost || 0) + (t.driverAdvanceGiven || 0));
    }

    const drivers = Object.values(driverMap).map((d: any) => ({
      ...d,
      netProfit: d.totalRevenue - d.totalCost,
      margin: d.totalRevenue > 0 ? Number(((d.totalRevenue - d.totalCost) / d.totalRevenue * 100).toFixed(1)) : 0,
      avgRevenuePerTrip: d.trips > 0 ? Math.round(d.totalRevenue / d.trips) : 0,
      avgTonnagePerTrip: d.trips > 0 ? Number((d.totalTonnage / d.trips).toFixed(1)) : 0,
      shortageRate: d.totalTonnage > 0 ? Number(((d.totalShortage / d.totalTonnage) * 100).toFixed(2)) : 0,
    })).sort((a: any, b: any) => b.netProfit - a.netProfit);

    return res.json({ drivers });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Profit by period (monthly/quarterly trends)
router.get('/by-period', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, groupBy = 'month' } = req.query;
    const tripWhere: any = { status: 'completed' };
    if (from || to) {
      tripWhere.tripDate = {};
      if (from) tripWhere.tripDate.gte = new Date(from as string);
      if (to) tripWhere.tripDate.lte = new Date(to as string);
    }

    const trips = await prisma.trip.findMany({
      where: tripWhere,
      select: {
        tripDate: true, revenue: true, fuelCost: true, driverAdvanceGiven: true,
        totalTripCost: true, deliveredQuantityTons: true, shortage: true,
      },
      orderBy: { tripDate: 'asc' },
    });

    const periodMap: any = {};
    for (const t of trips) {
      const d = new Date(t.tripDate);
      let key: string;
      if (groupBy === 'quarter') {
        const q = Math.ceil((d.getMonth() + 1) / 3);
        key = `${d.getFullYear()}-Q${q}`;
      } else if (groupBy === 'week') {
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        key = weekStart.toISOString().split('T')[0];
      } else {
        key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      }

      if (!periodMap[key]) {
        periodMap[key] = { period: key, trips: 0, tonnage: 0, revenue: 0, fuelCost: 0, driverCost: 0, totalCost: 0, shortage: 0 };
      }
      const p = periodMap[key];
      p.trips++;
      p.tonnage += t.deliveredQuantityTons || 0;
      p.revenue += t.revenue || 0;
      p.fuelCost += t.fuelCost || 0;
      p.driverCost += t.driverAdvanceGiven || 0;
      p.totalCost += (t.totalTripCost || 0) > 0 ? (t.totalTripCost || 0) : ((t.fuelCost || 0) + (t.driverAdvanceGiven || 0));
      p.shortage += t.shortage || 0;
    }

    const periods = Object.values(periodMap).map((p: any) => ({
      ...p,
      netProfit: p.revenue - p.totalCost,
      margin: p.revenue > 0 ? Number(((p.revenue - p.totalCost) / p.revenue * 100).toFixed(1)) : 0,
    }));

    return res.json({ periods, groupBy });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Margin analysis — trips ranked by margin %
router.get('/margin-analysis', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, limit = '50' } = req.query;
    const tripWhere: any = { status: 'completed', revenue: { gt: 0 } };
    if (from || to) {
      tripWhere.tripDate = {};
      if (from) tripWhere.tripDate.gte = new Date(from as string);
      if (to) tripWhere.tripDate.lte = new Date(to as string);
    }

    const trips = await prisma.trip.findMany({
      where: tripWhere,
      select: {
        id: true, tripNumber: true, tripDate: true, revenue: true,
        fuelCost: true, driverAdvanceGiven: true, totalTripCost: true,
        deliveredQuantityTons: true, shortage: true, shortageDeduction: true,
        pickupLocation: true, deliveryLocation: true, orderType: true,
        driver: { select: { firstName: true, lastName: true } },
        vehicle: { select: { plateNumber: true } },
        customer: { select: { companyName: true } },
      },
      orderBy: { tripDate: 'desc' },
    });

    const analyzed = trips.map(t => {
      const cost = (t.totalTripCost || 0) > 0 ? (t.totalTripCost || 0) : ((t.fuelCost || 0) + (t.driverAdvanceGiven || 0));
      const profit = (t.revenue || 0) - cost;
      const margin = (t.revenue || 0) > 0 ? Number(((profit / (t.revenue || 1)) * 100).toFixed(1)) : 0;
      return {
        tripNumber: t.tripNumber, tripDate: t.tripDate,
        route: `${t.pickupLocation} → ${t.deliveryLocation}`,
        customer: (t.customer as any)?.companyName || '-',
        driver: `${(t.driver as any)?.firstName || ''} ${(t.driver as any)?.lastName || ''}`.trim(),
        vehicle: (t.vehicle as any)?.plateNumber || '-',
        orderType: t.orderType, deliveredTons: t.deliveredQuantityTons || 0,
        revenue: t.revenue || 0, cost, profit, margin,
        shortage: t.shortage || 0,
      };
    });

    // Sort by margin (best to worst)
    analyzed.sort((a, b) => b.margin - a.margin);

    const topMargin = analyzed.slice(0, Number(limit));
    const bottomMargin = [...analyzed].sort((a, b) => a.margin - b.margin).slice(0, Number(limit));

    // Distribution
    const distribution = { negative: 0, low: 0, medium: 0, high: 0 };
    for (const t of analyzed) {
      if (t.margin < 0) distribution.negative++;
      else if (t.margin < 15) distribution.low++;
      else if (t.margin < 30) distribution.medium++;
      else distribution.high++;
    }

    const avgMargin = analyzed.length > 0 ? Number((analyzed.reduce((s, t) => s + t.margin, 0) / analyzed.length).toFixed(1)) : 0;

    return res.json({ topMargin, bottomMargin, distribution, avgMargin, totalTrips: analyzed.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Cost drivers — cost breakdown by category as percentages
router.get('/cost-drivers', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query;
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from as string);
    if (to) dateFilter.lte = new Date(to as string);
    const tripWhere: any = { status: 'completed' };
    if (from || to) tripWhere.tripDate = dateFilter;

    // Fuel costs from trips
    const trips = await prisma.trip.findMany({
      where: tripWhere,
      select: { revenue: true, fuelCost: true, driverAdvanceGiven: true, shortageDeduction: true,
                allocatedFuelCost: true, allocatedMaintenanceCost: true,
                allocatedDepreciationCost: true, allocatedDriverCost: true, totalTripCost: true },
    });
    const totalRevenue = trips.reduce((s, t) => s + (t.revenue || 0), 0);
    const fuelCost = trips.reduce((s, t) => s + (t.allocatedFuelCost || t.fuelCost || 0), 0);
    const driverCost = trips.reduce((s, t) => s + (t.allocatedDriverCost || t.driverAdvanceGiven || 0), 0);
    const maintenanceCost = trips.reduce((s, t) => s + (t.allocatedMaintenanceCost || 0), 0);
    const depreciationCost = trips.reduce((s, t) => s + (t.allocatedDepreciationCost || 0), 0);
    const shortageDeductions = trips.reduce((s, t) => s + (t.shortageDeduction || 0), 0);

    // Additional maintenance from work orders (if not allocated on trips)
    const woWhere: any = { status: 'completed' };
    if (from || to) woWhere.endTime = dateFilter;
    const workOrders = await prisma.workOrder.findMany({ where: woWhere, select: { totalCost: true } });
    const woMaintCost = workOrders.reduce((s, w) => s + (w.totalCost || 0), 0);
    const effectiveMaintCost = maintenanceCost > 0 ? maintenanceCost : woMaintCost;

    // Penalties
    const penaltyWhere: any = { status: { in: ['approved', 'applied'] } };
    if (from || to) penaltyWhere.createdAt = dateFilter;
    const penalties = await prisma.orderPenalty.findMany({ where: penaltyWhere, select: { amount: true, type: true } });
    const totalPenalties = penalties.reduce((s, p) => s + (p.amount || 0), 0);
    const penaltyByType: any = {};
    penalties.forEach(p => { penaltyByType[p.type] = (penaltyByType[p.type] || 0) + (p.amount || 0); });

    const totalCost = fuelCost + driverCost + effectiveMaintCost + depreciationCost;
    const pct = (v: number) => totalCost > 0 ? Number(((v / totalCost) * 100).toFixed(1)) : 0;

    const costBreakdown = [
      { category: 'Fuel', amount: fuelCost, percentage: pct(fuelCost), color: '#ef4444' },
      { category: 'Driver / Advance', amount: driverCost, percentage: pct(driverCost), color: '#f59e0b' },
      { category: 'Maintenance', amount: effectiveMaintCost, percentage: pct(effectiveMaintCost), color: '#3b82f6' },
      { category: 'Depreciation', amount: depreciationCost, percentage: pct(depreciationCost), color: '#8b5cf6' },
    ].filter(c => c.amount > 0);

    return res.json({
      costBreakdown, totalRevenue, totalCost,
      netProfit: totalRevenue - totalCost,
      margin: totalRevenue > 0 ? Number(((totalRevenue - totalCost) / totalRevenue * 100).toFixed(1)) : 0,
      shortageDeductions, totalPenalties, penaltyByType,
      tripCount: trips.length,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
