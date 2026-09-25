import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0);
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

    // 7 days ago start
    const startOfWeek = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    startOfWeek.setHours(0, 0, 0, 0);

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0);
    const yearStart = new Date(today.getFullYear(), 0, 1, 0, 0, 0);
    const in30Days = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);

    const [
      vehicles,
      todayTrips,
      weekTrips,
      monthTrips,
      ytdTrips,
      cashiers,
      todayCashTxs,
      invoices,
      pendingSettlementsCount,
      todayWorkOrders,
      weekWorkOrders,
      monthWorkOrders,
      ytdWorkOrders,
      allWorkOrders,
      overdueSchedules,
      systemAlerts,
      pendingOrdersCount,
      allInventory,
      pendingHandoversCount,
      fuelToday,
      rentalTrucksCount,
      pendingApprovalsData,
      recentTrips,
      recentOrders,
    ] = await Promise.all([
      // 1. Vehicles
      prisma.vehicle.findMany({
        select: {
          id: true,
          plateNumber: true,
          make: true,
          model: true,
          category: true,
          status: true,
          operationalStatus: true,
          currentKm: true,
          insuranceExpiry: true,
          inspectionExpiry: true,
          permitExpiry: true,
          roadFundExpiry: true,
          boloExpiry: true,
          libreExpiry: true,
          complianceLocked: true,
          lockReason: true,
        },
      }),

      // 2. Today's Trips
      prisma.trip.findMany({
        where: { tripDate: { gte: startOfDay, lte: endOfDay } },
        select: {
          id: true,
          tripNumber: true,
          vehicleId: true,
          driverId: true,
          status: true,
          deliveredQuantityTons: true,
          loadedQuantityTons: true,
          shortage: true,
          revenue: true,
          fuelCost: true,
          driverAdvanceGiven: true,
        },
      }),

      // 3. Week's Trips (Last 7 Days)
      prisma.trip.findMany({
        where: { tripDate: { gte: startOfWeek } },
        select: {
          tripDate: true,
          status: true,
          deliveredQuantityTons: true,
          loadedQuantityTons: true,
          shortage: true,
          revenue: true,
          fuelCost: true,
          driverAdvanceGiven: true,
        },
      }),

      // 4. Month's Trips
      prisma.trip.findMany({
        where: { tripDate: { gte: monthStart } },
        select: {
          status: true,
          deliveredQuantityTons: true,
          loadedQuantityTons: true,
          shortage: true,
          revenue: true,
          fuelCost: true,
          driverAdvanceGiven: true,
        },
      }),

      // 5. YTD Completed Trips
      prisma.trip.findMany({
        where: { status: 'completed', tripDate: { gte: yearStart } },
        select: {
          revenue: true,
          fuelCost: true,
          driverAdvanceGiven: true,
        },
      }),

      // 6. Cashiers
      prisma.cashier.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          code: true,
          location: true,
          floatAmount: true,
          currentBalance: true,
          isActive: true,
          sessions: {
            where: { status: 'open' },
            select: { id: true, openingBalance: true, totalCashIn: true, totalCashOut: true },
          },
        },
      }),

      // 7. Today's Cash Transactions
      prisma.cashTransaction.findMany({
        where: { createdAt: { gte: startOfDay } },
        select: { cashierId: true, type: true, amount: true },
      }),

      // 8. Invoices (Unpaid / Partial / Overdue / Sent)
      prisma.invoice.findMany({
        where: { status: { in: ['unpaid', 'partial', 'overdue', 'sent'] } },
        include: { customer: { select: { id: true, companyName: true, phone: true } } },
      }),

      // 9. Pending Settlements count
      prisma.settlement.count({ where: { status: { in: ['draft', 'reviewed'] } } }),

      // 10. Work Orders Today
      prisma.workOrder.findMany({
        where: { createdAt: { gte: startOfDay } },
        select: { id: true, vehicleId: true, totalCost: true, laborCost: true, partsCost: true, status: true },
      }),

      // 11. Work Orders Week
      prisma.workOrder.findMany({
        where: { createdAt: { gte: startOfWeek } },
        select: { id: true, vehicleId: true, totalCost: true, createdAt: true, status: true },
      }),

      // 12. Work Orders Month
      prisma.workOrder.findMany({
        where: { createdAt: { gte: monthStart } },
        select: { id: true, vehicleId: true, totalCost: true, status: true },
      }),

      // 13. Work Orders YTD
      prisma.workOrder.findMany({
        where: { createdAt: { gte: yearStart } },
        select: { id: true, vehicleId: true, totalCost: true },
      }),

      // 14. All Work Orders for Per-Truck aggregate
      prisma.workOrder.findMany({
        select: {
          id: true,
          vehicleId: true,
          totalCost: true,
          status: true,
          createdAt: true,
          endTime: true,
        },
      }),

      // 15. Maintenance Schedules overdue or due soon
      prisma.maintenanceSchedule.findMany({
        where: { status: { in: ['overdue', 'due_soon'] } },
        include: { vehicle: { select: { id: true, plateNumber: true, make: true, model: true } } },
      }),

      // 16. Unresolved Alerts
      prisma.alert.findMany({
        where: { isResolved: false },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),

      // 17. Pending orders
      prisma.customerOrder.count({ where: { status: { in: ['submitted', 'approved'] } } }),

      // 18. Inventory items
      prisma.inventory.findMany({ select: { quantityInStock: true, minimumStock: true } }),

      // 19. Pending Handovers
      prisma.vehicleHandover.count({ where: { status: 'pending' } }),

      // 20. Fuel logs today
      prisma.fuelLog.findMany({ where: { date: { gte: startOfDay, lte: endOfDay } }, select: { totalCost: true, liters: true } }),

      // 21. Rental trucks active
      prisma.rentalVehicle.count({ where: { isActive: true } }),

      // 22. Approvals
      Promise.all([
        prisma.customerOrder.count({ where: { status: 'submitted' } }),
        prisma.purchaseRequest.count({ where: { status: 'pending' } }),
        prisma.driverAdvance.count({ where: { status: 'requested' } }),
        prisma.payroll.count({ where: { status: 'draft' } }),
        prisma.approvalRequest.count({ where: { status: 'pending' } }),
      ]),

      // 23. Recent Trips
      prisma.trip.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          vehicle: { select: { plateNumber: true } },
          driver: { select: { firstName: true, lastName: true } },
          customer: { select: { companyName: true } },
        },
      }),

      // 24. Recent Orders
      prisma.customerOrder.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: { customer: { select: { companyName: true } } },
      }),
    ]);

    // ─────────────────────────────────────────────────────────────
    // 1. CASHIER ACCOUNT SUMMARY
    // ─────────────────────────────────────────────────────────────
    let cashierTotalBalance = 0;
    let cashierTodayTotalIn = 0;
    let cashierTodayTotalOut = 0;

    const cashierTxMap = new Map<string, { in: number; out: number }>();
    for (const tx of todayCashTxs) {
      if (!cashierTxMap.has(tx.cashierId)) {
        cashierTxMap.set(tx.cashierId, { in: 0, out: 0 });
      }
      const record = cashierTxMap.get(tx.cashierId)!;
      if (tx.type === 'in') {
        record.in += tx.amount || 0;
        cashierTodayTotalIn += tx.amount || 0;
      } else {
        record.out += tx.amount || 0;
        cashierTodayTotalOut += tx.amount || 0;
      }
    }

    const cashierList = cashiers.map(c => {
      cashierTotalBalance += c.currentBalance || 0;
      const txs = cashierTxMap.get(c.id) || { in: 0, out: 0 };
      return {
        id: c.id,
        name: c.name,
        code: c.code || '-',
        location: c.location || 'Main Office',
        floatAmount: c.floatAmount || 0,
        currentBalance: c.currentBalance || 0,
        isActive: c.isActive,
        hasOpenSession: c.sessions.length > 0,
        todayIn: txs.in,
        todayOut: txs.out,
      };
    });

    const cashierSummary = {
      totalBalance: cashierTotalBalance,
      activeCashiersCount: cashiers.length,
      todayCashIn: cashierTodayTotalIn,
      todayCashOut: cashierTodayTotalOut,
      netCashFlowToday: cashierTodayTotalIn - cashierTodayTotalOut,
      cashiers: cashierList,
    };

    // ─────────────────────────────────────────────────────────────
    // 2. RECEIVABLE ACCOUNT SUMMARY
    // ─────────────────────────────────────────────────────────────
    let totalReceivableAmount = 0;
    let totalOverdueAmount = 0;
    let totalBilledInvoices = 0;
    let totalCollectedInvoices = 0;
    let overdueInvoicesCount = 0;

    const customerReceivablesMap = new Map<string, any>();

    for (const inv of invoices) {
      const cid = inv.customerId || 'unknown';
      const cname = inv.customer?.companyName || 'Unknown Customer';
      const balance = inv.balanceDue || 0;
      const isOverdue = inv.status === 'overdue' || (inv.dueDate && new Date(inv.dueDate) < today && balance > 0);
      const overdueAmt = isOverdue ? balance : 0;

      totalReceivableAmount += balance;
      totalBilledInvoices += inv.totalAmount || 0;
      totalCollectedInvoices += inv.paidAmount || 0;
      if (isOverdue) {
        totalOverdueAmount += balance;
        overdueInvoicesCount++;
      }

      if (!customerReceivablesMap.has(cid)) {
        customerReceivablesMap.set(cid, {
          customerId: cid,
          customerName: cname,
          phone: inv.customer?.phone || null,
          totalBilled: 0,
          totalCollected: 0,
          remainingBalance: 0,
          overdueAmount: 0,
          invoiceCount: 0,
          overdueCount: 0,
        });
      }

      const cm = customerReceivablesMap.get(cid);
      cm.totalBilled += inv.totalAmount || 0;
      cm.totalCollected += inv.paidAmount || 0;
      cm.remainingBalance += balance;
      cm.invoiceCount += 1;
      if (isOverdue) {
        cm.overdueAmount += balance;
        cm.overdueCount += 1;
      }
    }

    const customerReceivablesList = Array.from(customerReceivablesMap.values()).sort(
      (a, b) => b.remainingBalance - a.remainingBalance
    );

    const receivablesSummary = {
      totalReceivable: totalReceivableAmount,
      totalOverdue: totalOverdueAmount,
      totalBilled: totalBilledInvoices,
      totalCollected: totalCollectedInvoices,
      collectionRate: totalBilledInvoices > 0 ? Number(((totalCollectedInvoices / totalBilledInvoices) * 100).toFixed(1)) : 0,
      invoiceCount: invoices.length,
      overdueCount: overdueInvoicesCount,
      pendingSettlementsCount,
      customerDetails: customerReceivablesList,
    };

    // ─────────────────────────────────────────────────────────────
    // 3. DELIVERY SUMMARY (TRIP PER DAY, PER WEEK, PER MONTH)
    // ─────────────────────────────────────────────────────────────
    // Day (Today)
    const todayTripsCount = todayTrips.length;
    const todayActiveTrips = todayTrips.filter(t => !['completed', 'cancelled'].includes(t.status)).length;
    const todayCompletedTrips = todayTrips.filter(t => t.status === 'completed').length;
    const todayTonnage = todayTrips.reduce((s, t) => s + (t.deliveredQuantityTons || t.loadedQuantityTons || 0), 0);
    const todayRevenue = todayTrips.reduce((s, t) => s + (t.revenue || 0), 0);
    const todayFuelCost = todayTrips.reduce((s, t) => s + (t.fuelCost || 0), 0);
    const todayDriverCost = todayTrips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);
    const todayTotalCost = todayFuelCost + todayDriverCost;

    // Week (Last 7 Days)
    const weekTripsCount = weekTrips.length;
    const weekCompletedTrips = weekTrips.filter(t => t.status === 'completed').length;
    const weekTonnage = weekTrips.reduce((s, t) => s + (t.deliveredQuantityTons || t.loadedQuantityTons || 0), 0);
    const weekRevenue = weekTrips.reduce((s, t) => s + (t.revenue || 0), 0);
    const weekFuelCost = weekTrips.reduce((s, t) => s + (t.fuelCost || 0), 0);
    const weekDriverCost = weekTrips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);
    const weekTotalCost = weekFuelCost + weekDriverCost;

    // Month (Current Month)
    const monthTripsCount = monthTrips.length;
    const monthCompletedTrips = monthTrips.filter(t => t.status === 'completed').length;
    const monthTonnage = monthTrips.reduce((s, t) => s + (t.deliveredQuantityTons || t.loadedQuantityTons || 0), 0);
    const monthRevenue = monthTrips.reduce((s, t) => s + (t.revenue || 0), 0);
    const monthFuelCost = monthTrips.reduce((s, t) => s + (t.fuelCost || 0), 0);
    const monthDriverCost = monthTrips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);
    const monthTotalCost = monthFuelCost + monthDriverCost;
    const monthLoadedTons = monthTrips.reduce((s, t) => s + (t.loadedQuantityTons || t.deliveredQuantityTons || 0), 0);
    const monthShortageTons = monthTrips.reduce((s, t) => s + (t.shortage || 0), 0);
    const shortageRate = monthLoadedTons > 0 ? Number(((monthShortageTons / monthLoadedTons) * 100).toFixed(1)) : 0;

    // 7-day Day-by-Day delivery trend chart
    const dailyDeliveryTrend: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      const dEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

      const dayMatching = weekTrips.filter((t: any) => {
        if (!t.tripDate) return false;
        const td = new Date(t.tripDate);
        return td >= dStart && td <= dEnd;
      });

      const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
      const dateStr = d.toISOString().slice(5, 10);
      dailyDeliveryTrend.push({
        date: dateStr,
        dayName,
        trips: dayMatching.length,
        completedTrips: dayMatching.filter((t: any) => t.status === 'completed').length,
        tonnage: Number((dayMatching.reduce((s: number, t: any) => s + (t.deliveredQuantityTons || t.loadedQuantityTons || 0), 0)).toFixed(1)),
        revenue: dayMatching.reduce((s: number, t: any) => s + (t.revenue || 0), 0),
        cost: dayMatching.reduce((s: number, t: any) => s + (t.fuelCost || 0) + (t.driverAdvanceGiven || 0), 0),
      });
    }

    const deliverySummary = {
      day: {
        totalTrips: todayTripsCount,
        activeTrips: todayActiveTrips,
        completedTrips: todayCompletedTrips,
        tonnage: Number(todayTonnage.toFixed(1)),
        revenue: todayRevenue,
        cost: todayTotalCost,
        profit: todayRevenue - todayTotalCost,
        fuelCost: todayFuelCost,
      },
      week: {
        totalTrips: weekTripsCount,
        completedTrips: weekCompletedTrips,
        tonnage: Number(weekTonnage.toFixed(1)),
        revenue: weekRevenue,
        cost: weekTotalCost,
        profit: weekRevenue - weekTotalCost,
        fuelCost: weekFuelCost,
      },
      month: {
        totalTrips: monthTripsCount,
        completedTrips: monthCompletedTrips,
        tonnage: Number(monthTonnage.toFixed(1)),
        revenue: monthRevenue,
        cost: monthTotalCost,
        profit: monthRevenue - monthTotalCost,
        fuelCost: monthFuelCost,
        shortageTons: Number(monthShortageTons.toFixed(2)),
        shortageRate,
      },
      trend: dailyDeliveryTrend,
    };

    // ─────────────────────────────────────────────────────────────
    // 4. TRUCK SUMMARY (GARAGE / MAINTENANCE EXPENSES PER DAY & PER TRUCK)
    // ─────────────────────────────────────────────────────────────
    const todayGarageCost = todayWorkOrders.reduce((s, w) => s + (w.totalCost || 0), 0);
    const weekGarageCost = weekWorkOrders.reduce((s, w) => s + (w.totalCost || 0), 0);
    const monthGarageCost = monthWorkOrders.reduce((s, w) => s + (w.totalCost || 0), 0);
    const ytdGarageCost = ytdWorkOrders.reduce((s, w) => s + (w.totalCost || 0), 0);

    // 7-day garage spend trend
    const garageTrend: any[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      const dEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

      const dayOrders = weekWorkOrders.filter((w: any) => {
        const cd = new Date(w.createdAt);
        return cd >= dStart && cd <= dEnd;
      });

      garageTrend.push({
        date: d.toISOString().slice(5, 10),
        dayName: d.toLocaleDateString('en-US', { weekday: 'short' }),
        cost: dayOrders.reduce((s, w) => s + (w.totalCost || 0), 0),
        count: dayOrders.length,
      });
    }

    // Per truck maintenance map
    const vehicleWorkMap = new Map<string, {
      todayCost: number;
      weekCost: number;
      monthCost: number;
      totalCost: number;
      workOrdersCount: number;
      activeWorkOrders: number;
      lastMaintenanceDate: Date | null;
    }>();

    for (const wo of allWorkOrders) {
      if (!vehicleWorkMap.has(wo.vehicleId)) {
        vehicleWorkMap.set(wo.vehicleId, {
          todayCost: 0,
          weekCost: 0,
          monthCost: 0,
          totalCost: 0,
          workOrdersCount: 0,
          activeWorkOrders: 0,
          lastMaintenanceDate: null,
        });
      }

      const rec = vehicleWorkMap.get(wo.vehicleId)!;
      const cost = wo.totalCost || 0;
      rec.totalCost += cost;
      rec.workOrdersCount += 1;

      if (['open', 'in_progress'].includes(wo.status)) {
        rec.activeWorkOrders += 1;
      }

      const woDate = new Date(wo.createdAt);
      if (woDate >= startOfDay) rec.todayCost += cost;
      if (woDate >= startOfWeek) rec.weekCost += cost;
      if (woDate >= monthStart) rec.monthCost += cost;

      if (!rec.lastMaintenanceDate || woDate > rec.lastMaintenanceDate) {
        rec.lastMaintenanceDate = woDate;
      }
    }

    const truckExpenses = vehicles.map(v => {
      const wInfo = vehicleWorkMap.get(v.id) || {
        todayCost: 0,
        weekCost: 0,
        monthCost: 0,
        totalCost: 0,
        workOrdersCount: 0,
        activeWorkOrders: 0,
        lastMaintenanceDate: null,
      };

      return {
        id: v.id,
        plateNumber: v.plateNumber,
        make: v.make,
        model: v.model,
        category: v.category,
        status: v.status,
        currentKm: v.currentKm,
        todayExpense: wInfo.todayCost,
        weekExpense: wInfo.weekCost,
        monthExpense: wInfo.monthCost,
        totalExpense: wInfo.totalCost,
        workOrdersCount: wInfo.workOrdersCount,
        activeWorkOrders: wInfo.activeWorkOrders,
        lastMaintenanceDate: wInfo.lastMaintenanceDate ? wInfo.lastMaintenanceDate.toISOString().slice(0, 10) : null,
      };
    }).sort((a, b) => b.monthExpense - a.monthExpense);

    const truckSummary = {
      todayGarageExpense: todayGarageCost,
      weekGarageExpense: weekGarageCost,
      monthGarageExpense: monthGarageCost,
      ytdGarageExpense: ytdGarageCost,
      activeWorkOrdersCount: allWorkOrders.filter(w => ['open', 'in_progress'].includes(w.status)).length,
      garageTrend,
      truckExpenses,
    };

    // ─────────────────────────────────────────────────────────────
    // 5. ALERT SUMMARY (INSURANCE, COMPLIANCE & DAYS BEFORE EXPIRY)
    // ─────────────────────────────────────────────────────────────
    const insuranceAlerts: any[] = [];
    const otherComplianceAlerts: any[] = [];

    const calculateDaysLeft = (targetDate: Date | null) => {
      if (!targetDate) return null;
      const tDate = new Date(targetDate);
      const diffMs = tDate.getTime() - today.getTime();
      return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    };

    const getExpiryStatus = (days: number | null) => {
      if (days === null) return 'none';
      if (days < 0) return 'expired';
      if (days <= 7) return 'critical';
      if (days <= 30) return 'warning';
      return 'good';
    };

    for (const v of vehicles) {
      // 1. Insurance
      if (v.insuranceExpiry) {
        const days = calculateDaysLeft(v.insuranceExpiry);
        const status = getExpiryStatus(days);
        if (days !== null && days <= 30) {
          insuranceAlerts.push({
            vehicleId: v.id,
            plateNumber: v.plateNumber,
            make: v.make,
            model: v.model,
            expiryDate: new Date(v.insuranceExpiry).toISOString().slice(0, 10),
            daysRemaining: days,
            status,
          });
        }
      }

      // 2. Inspection / Bolo
      const inspDate = v.inspectionExpiry || v.boloExpiry;
      if (inspDate) {
        const days = calculateDaysLeft(inspDate);
        const status = getExpiryStatus(days);
        if (days !== null && days <= 30) {
          otherComplianceAlerts.push({
            vehicleId: v.id,
            plateNumber: v.plateNumber,
            docType: 'Inspection / Bolo',
            expiryDate: new Date(inspDate).toISOString().slice(0, 10),
            daysRemaining: days,
            status,
          });
        }
      }

      // 3. Permit / Road Fund
      const permitDate = v.permitExpiry || v.roadFundExpiry;
      if (permitDate) {
        const days = calculateDaysLeft(permitDate);
        const status = getExpiryStatus(days);
        if (days !== null && days <= 30) {
          otherComplianceAlerts.push({
            vehicleId: v.id,
            plateNumber: v.plateNumber,
            docType: 'Permit / Road Fund',
            expiryDate: new Date(permitDate).toISOString().slice(0, 10),
            daysRemaining: days,
            status,
          });
        }
      }
    }

    // Sort alerts: most urgent / overdue first
    insuranceAlerts.sort((a, b) => a.daysRemaining - b.daysRemaining);
    otherComplianceAlerts.sort((a, b) => a.daysRemaining - b.daysRemaining);

    // Overdue maintenance schedules
    const maintenanceAlertsList = overdueSchedules.map(s => {
      const days = s.nextDueDate ? calculateDaysLeft(s.nextDueDate) : null;
      return {
        id: s.id,
        vehicleId: s.vehicleId,
        plateNumber: s.vehicle?.plateNumber || 'Unknown',
        make: s.vehicle?.make || '',
        model: s.vehicle?.model || '',
        maintenanceType: s.maintenanceType,
        status: s.status,
        dueDate: s.nextDueDate ? new Date(s.nextDueDate).toISOString().slice(0, 10) : null,
        daysRemaining: days,
      };
    }).sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0));

    // Vehicle status counts
    const vehicleStatusCounts = {
      total: vehicles.length,
      active: vehicles.filter(v => v.status === 'active').length,
      maintenance: vehicles.filter(v => v.status === 'maintenance').length,
      breakdown: vehicles.filter(v => v.status === 'breakdown').length,
      inactive: vehicles.filter(v => v.status === 'inactive').length,
      locked: vehicles.filter(v => v.complianceLocked).length,
    };

    const alertSummary = {
      totalInsuranceAlerts: insuranceAlerts.length,
      expiredInsuranceCount: insuranceAlerts.filter(a => a.daysRemaining < 0).length,
      urgentInsuranceCount: insuranceAlerts.filter(a => a.daysRemaining >= 0 && a.daysRemaining <= 7).length,
      warningInsuranceCount: insuranceAlerts.filter(a => a.daysRemaining > 7 && a.daysRemaining <= 30).length,
      insuranceAlerts,
      complianceAlerts: otherComplianceAlerts,
      maintenanceAlerts: maintenanceAlertsList,
      vehicleStatus: vehicleStatusCounts,
      unresolvedSystemAlerts: systemAlerts.map(a => ({
        id: a.id,
        title: a.title,
        message: a.message,
        severity: a.severity,
        type: a.type,
        createdAt: a.createdAt,
      })),
    };

    // ─────────────────────────────────────────────────────────────
    // APPROVALS & UTILIZATION
    // ─────────────────────────────────────────────────────────────
    const [pendingOrderAppr, pendingPR, pendingAdv, pendingPayroll, pendingApprovalReqs] = pendingApprovalsData;
    const pendingApprovals = {
      orders: pendingOrderAppr,
      purchases: pendingPR,
      advances: pendingAdv,
      payrolls: pendingPayroll,
      approvalRequests: pendingApprovalReqs,
      total: pendingOrderAppr + pendingPR + pendingAdv + pendingPayroll + pendingApprovalReqs,
    };

    const todayVehiclesOnTrip = todayTrips.filter(t => !['completed', 'cancelled'].includes(t.status));
    const uniqueVehiclesOnTrip = new Set(todayVehiclesOnTrip.map(t => t.vehicleId)).size;
    const activeVehiclesTotal = vehicleStatusCounts.active;

    // YTD Summary
    const ytdRevenue = ytdTrips.reduce((s, t) => s + (t.revenue || 0), 0);
    const ytdFuelCost = ytdTrips.reduce((s, t) => s + (t.fuelCost || 0), 0);
    const ytdDriverCost = ytdTrips.reduce((s, t) => s + (t.driverAdvanceGiven || 0), 0);

    return res.json({
      // 5 Core Summaries
      cashierSummary,
      receivablesSummary,
      deliverySummary,
      truckSummary,
      alertSummary,

      // Compatibility & existing properties
      vehicles: vehicleStatusCounts,
      today: deliverySummary.day,
      cashiers: cashierList.map(c => ({ id: c.id, name: c.name, location: c.location, balance: c.currentBalance })),
      cashierBalance: cashierTotalBalance,
      revenueTrend: dailyDeliveryTrend.map(d => ({ date: d.date, revenue: d.revenue, cost: d.cost })),
      outstandingInvoices: { count: invoices.length, total: totalReceivableAmount, overdueCount: overdueInvoicesCount },
      uncollectedMoney: { total: totalReceivableAmount, details: customerReceivablesList },
      monthSummary: {
        revenue: monthRevenue,
        fuelCost: monthFuelCost,
        driverCost: monthDriverCost,
        profit: monthRevenue - monthTotalCost,
      },
      ytd: {
        revenue: ytdRevenue,
        fuelCost: ytdFuelCost,
        driverCost: ytdDriverCost,
        maintenanceCost: ytdGarageCost,
        profit: ytdRevenue - ytdFuelCost - ytdDriverCost - ytdGarageCost,
      },
      shortageRate,
      rentalTrucks: rentalTrucksCount,
      pendingApprovals,
      recentTrips,
      recentOrders,
      alerts: {
        pendingOrders: pendingOrdersCount,
        lowStock: allInventory.filter(i => i.quantityInStock <= i.minimumStock).length,
        maintenanceDue: overdueSchedules.length,
        complianceAlerts: insuranceAlerts.length + otherComplianceAlerts.length,
        pendingHandovers: pendingHandoversCount,
      },
      utilization: {
        fleet: activeVehiclesTotal > 0 ? Math.round((uniqueVehiclesOnTrip / activeVehiclesTotal) * 100) : 0,
        vehiclesOnTrip: uniqueVehiclesOnTrip,
      },
    });
  } catch (e: any) {
    console.error('Dashboard error:', e);
    return res.status(500).json({ error: e.message });
  }
});

export default router;
