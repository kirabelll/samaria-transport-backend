import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);
    const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const yearStart = new Date(today.getFullYear(), 0, 1);
    const last30 = new Date(today.getTime() - 30 * 86400000);

    const [vTotal, vActive, vMaint, vBreak, vInactive, todayTrips,
      pendingOrders, allInv, overdueSched, cashiers, recentTrips, recentOrders,
      pendingHandovers, fuelToday, rentalTrucks] = await Promise.all([
      prisma.vehicle.count(),
      prisma.vehicle.count({ where: { status: 'active' } }),
      prisma.vehicle.count({ where: { status: 'maintenance' } }),
      prisma.vehicle.count({ where: { status: 'breakdown' } }),
      prisma.vehicle.count({ where: { status: 'inactive' } }),
      prisma.trip.findMany({ where: { tripDate: { gte: start, lte: end } }, select: { deliveredQuantityTons: true, revenue: true, fuelCost: true, status: true, driverAdvanceGiven: true } }),
      prisma.customerOrder.count({ where: { status: { in: ['submitted', 'approved'] } } }),
      prisma.inventory.findMany({ select: { quantityInStock: true, minimumStock: true } }),
      prisma.maintenanceSchedule.count({ where: { status: 'overdue' } }),
      prisma.cashier.findMany({ where: { isActive: true }, select: { id: true, name: true, location: true, currentBalance: true } }),
      prisma.trip.findMany({ take: 5, orderBy: { createdAt: 'desc' }, include: { vehicle: { select: { plateNumber: true } }, driver: { select: { firstName: true, lastName: true } }, customer: { select: { companyName: true } } } }),
      prisma.customerOrder.findMany({ take: 5, orderBy: { createdAt: 'desc' }, include: { customer: { select: { companyName: true } } } }),
      prisma.vehicleHandover.count({ where: { status: 'pending' } }),
      prisma.fuelLog.findMany({ where: { date: { gte: start, lte: end } }, select: { totalCost: true, liters: true } }),
      prisma.rentalVehicle.count({ where: { isActive: true } }),
    ]);

    // Pending approvals
    const [pendingOrderAppr, pendingPR, pendingAdv, pendingPayroll, pendingApprovalReqs] = await Promise.all([
      prisma.customerOrder.count({ where: { status: 'submitted' } }),
      prisma.purchaseRequest.count({ where: { status: 'pending' } }),
      prisma.driverAdvance.count({ where: { status: 'requested' } }),
      prisma.payroll.count({ where: { status: 'draft' } }),
      prisma.approvalRequest.count({ where: { status: 'pending' } }),
    ]);
    const pendingApprovals = {
      orders: pendingOrderAppr, purchases: pendingPR, advances: pendingAdv,
      payrolls: pendingPayroll, approvalRequests: pendingApprovalReqs,
      total: pendingOrderAppr + pendingPR + pendingAdv + pendingPayroll + pendingApprovalReqs,
    };

    // Compliance alerts count
    const vehicleCompliance = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      select: { insuranceExpiry: true, inspectionExpiry: true, permitExpiry: true, complianceLocked: true },
    });
    let complianceAlerts = 0;
    let lockedVehicles = 0;
    for (const v of vehicleCompliance) {
      if ((v as any).complianceLocked) lockedVehicles++;
      if (v.insuranceExpiry && new Date(v.insuranceExpiry) <= in30Days) complianceAlerts++;
      if (v.inspectionExpiry && new Date(v.inspectionExpiry) <= in30Days) complianceAlerts++;
      if (v.permitExpiry && new Date(v.permitExpiry) <= in30Days) complianceAlerts++;
    }

    // Monthly profit summary
    const monthTrips = await prisma.trip.findMany({
      where: { status: 'completed', tripDate: { gte: monthStart } },
      select: { revenue: true, fuelCost: true, deliveredQuantityTons: true, loadedQuantityTons: true, shortage: true, driverAdvanceGiven: true },
    });
    const monthRevenue = monthTrips.reduce((s, t) => s + (t.revenue || 0), 0);
    const monthFuel = monthTrips.reduce((s, t) => s + (t.fuelCost || 0), 0);
    const monthDriverCost = monthTrips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);

    // Fleet & Driver utilization
    const todayVehiclesOnTrip = await prisma.trip.findMany({
      where: { tripDate: { gte: start, lte: end }, status: { not: 'cancelled' } },
      select: { vehicleId: true, driverId: true }, distinct: ['vehicleId'],
    });
    const totalDrivers = await prisma.employee.count({ where: { role: 'driver', status: 'active' } });
    const driversOnTrip = new Set(todayVehiclesOnTrip.map(t => t.driverId)).size;

    // 7-day revenue trend
    const revenueTrend = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
      const dayTrips = await prisma.trip.findMany({
        where: { status: 'completed', tripDate: { gte: dayStart, lte: dayEnd } },
        select: { revenue: true, fuelCost: true },
      });
      revenueTrend.push({
        date: dayStart.toISOString().slice(5, 10),
        revenue: dayTrips.reduce((s, t) => s + (t.revenue || 0), 0),
        cost: dayTrips.reduce((s, t) => s + (t.fuelCost || 0), 0),
      });
    }

    // Outstanding invoices
    const outstandingInvoices = await prisma.invoice.findMany({
      where: { status: { in: ['unpaid', 'partial', 'overdue', 'sent'] } },
      select: { balanceDue: true, status: true },
    });
    const outstandingTotal = outstandingInvoices.reduce((s, i) => s + (i.balanceDue || 0), 0);
    const overdueInvoiceCount = outstandingInvoices.filter(i => i.status === 'overdue').length;

    // YTD P&L
    const ytdTrips = await prisma.trip.findMany({
      where: { status: 'completed', tripDate: { gte: yearStart } },
      select: { revenue: true, fuelCost: true, driverAdvanceGiven: true },
    });
    const ytdRevenue = ytdTrips.reduce((s, t) => s + (t.revenue || 0), 0);
    const ytdFuelCost = ytdTrips.reduce((s, t) => s + (t.fuelCost || 0), 0);
    const ytdDriverCost = ytdTrips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);
    const ytdMaintenanceCost = (await prisma.workOrder.findMany({
      where: { status: 'completed', endTime: { gte: yearStart } }, select: { totalCost: true },
    })).reduce((s, w) => s + (w.totalCost || 0), 0);

    // Shortage rate this month
    const monthTotalLoaded = monthTrips.reduce((s, t) => s + (t.loadedQuantityTons || t.deliveredQuantityTons || 0), 0);
    const monthTotalShortage = monthTrips.reduce((s, t) => s + (t.shortage || 0), 0);
    const shortageRate = monthTotalLoaded > 0 ? (monthTotalShortage / monthTotalLoaded * 100) : 0;

    // Phase 9: Additional KPIs

    // Operations: active trips, delayed, pending POD
    const [activeTrips, delayedTrips, pendingPod] = await Promise.all([
      prisma.trip.count({ where: { status: { in: ['dispatched', 'loading', 'in_transit', 'delivering'] } } }),
      prisma.trip.count({ where: { status: 'in_transit', departureTime: { lt: new Date(Date.now() - 24 * 3600000) } } }),
      prisma.trip.count({ where: { status: 'completed', podUrl: null } }),
    ]);

    // Financial: pending settlements, receivables aging
    const [pendingSettlements, cashSessions] = await Promise.all([
      prisma.settlement.count({ where: { status: { in: ['draft', 'reviewed'] } } }),
      prisma.cashierSession.findMany({
        where: { status: 'open' },
        select: { cashierId: true, openingBalance: true, totalCashIn: true, totalCashOut: true },
      }),
    ]);

    // Controls: unresolved alerts
    const [alertCritical, alertUrgent, alertWarning, alertTotal] = await Promise.all([
      prisma.alert.count({ where: { severity: 'critical', isResolved: false } }),
      prisma.alert.count({ where: { severity: 'urgent', isResolved: false } }),
      prisma.alert.count({ where: { severity: 'warning', isResolved: false } }),
      prisma.alert.count({ where: { isResolved: false } }),
    ]);

    // Profitability: daily revenue/cost/profit (today)
    const todayRevenue = todayTrips.reduce((s, t) => s + (t.revenue || 0), 0);
    const todayCost = todayTrips.reduce((s, t) => s + (t.fuelCost || 0) + (t.driverAdvanceGiven || 0), 0);

    // Qty mismatch count (shortage > 5%)
    const qtyMismatchTrips = await prisma.trip.count({
      where: { status: 'completed', shortage: { gt: 0 }, updatedAt: { gt: new Date(Date.now() - 7 * 86400000) } },
    });

    // B8: Uncollected customer money
    const uncollectedInvoices = await prisma.invoice.findMany({
      where: { status: { in: ['unpaid', 'partial', 'overdue'] } },
      include: { customer: true },
    });
    const uncollectedByCustomer: any[] = [];
    const customerMap = new Map<string, any>();
    for (const inv of uncollectedInvoices) {
      const cid = inv.customerId;
      if (!customerMap.has(cid)) {
        customerMap.set(cid, { customerId: cid, customerName: (inv as any).customer?.companyName || 'Unknown',
          totalBilled: 0, totalCollected: 0, remainingBalance: 0, overdueAmount: 0 });
      }
      const cm = customerMap.get(cid);
      cm.totalBilled += inv.totalAmount || 0;
      cm.totalCollected += inv.paidAmount || 0;
      cm.remainingBalance += inv.balanceDue || 0;
      if (inv.status === 'overdue') cm.overdueAmount += inv.balanceDue || 0;
    }
    customerMap.forEach(v => uncollectedByCustomer.push(v));
    const totalUncollected = uncollectedByCustomer.reduce((s, c) => s + c.remainingBalance, 0);

    return res.json({
      vehicles: { total: vTotal, active: vActive, maintenance: vMaint, breakdown: vBreak, inactive: vInactive, locked: lockedVehicles },
      today: {
        trips: todayTrips.length,
        activeTrips: todayTrips.filter(t => !['completed', 'cancelled'].includes(t.status)).length,
        tonnage: todayTrips.reduce((s, t) => s + (t.deliveredQuantityTons || 0), 0),
        revenue: todayRevenue,
        cost: todayCost,
        profit: todayRevenue - todayCost,
        fuelCost: fuelToday.reduce((s, f) => s + f.totalCost, 0),
        fuelLiters: fuelToday.reduce((s, f) => s + f.liters, 0),
      },
      alerts: {
        pendingOrders, lowStock: allInv.filter(i => i.quantityInStock <= i.minimumStock).length,
        maintenanceDue: overdueSched, complianceAlerts, pendingHandovers,
      },
      cashiers: cashiers.map(c => ({ id: c.id, name: c.name, location: (c as any).location, balance: c.currentBalance })),
      cashierBalance: cashiers.reduce((s, c) => s + (c.currentBalance || 0), 0),
      rentalTrucks,
      pendingApprovals,
      monthSummary: { revenue: monthRevenue, fuelCost: monthFuel, driverCost: monthDriverCost, profit: monthRevenue - monthFuel - monthDriverCost },
      recentTrips, recentOrders,
      utilization: {
        fleet: vActive > 0 ? Math.round(todayVehiclesOnTrip.length / vActive * 100) : 0,
        drivers: totalDrivers > 0 ? Math.round(driversOnTrip / totalDrivers * 100) : 0,
        vehiclesOnTrip: todayVehiclesOnTrip.length,
        totalDrivers, driversOnTrip,
      },
      revenueTrend,
      outstandingInvoices: { count: outstandingInvoices.length, total: outstandingTotal, overdueCount: overdueInvoiceCount },
      ytd: { revenue: ytdRevenue, fuelCost: ytdFuelCost, driverCost: ytdDriverCost, maintenanceCost: ytdMaintenanceCost, profit: ytdRevenue - ytdFuelCost - ytdDriverCost - ytdMaintenanceCost },
      shortageRate: Number(shortageRate.toFixed(1)),
      // Phase 9 additions
      operations: { activeTrips, delayedTrips, pendingPod, qtyMismatchTrips },
      financial: { pendingSettlements, cashSessions: cashSessions.length },
      controls: { alertCritical, alertUrgent, alertWarning, alertTotal, lockedVehicles, pendingApprovalCount: pendingApprovals.total },
      profitability: { dailyRevenue: todayRevenue, dailyCost: todayCost, dailyProfit: todayRevenue - todayCost,
        monthRevenue, monthProfit: monthRevenue - monthFuel - monthDriverCost,
        monthMargin: monthRevenue > 0 ? Number(((monthRevenue - monthFuel - monthDriverCost) / monthRevenue * 100).toFixed(1)) : 0 },
      // B8: Uncollected customer money
      uncollectedMoney: { total: totalUncollected, details: uncollectedByCustomer },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});
export default router;
