import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { sendNotification } from '../utils/telegram';
import { postJournalEntry } from '../utils/auto-journal';
import { createAlert } from '../utils/alert-engine';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
const router = Router();
router.use(authenticate);

// POD / weighbridge file upload setup
const podDir = path.join(__dirname, '../../uploads/pod');
if (!fs.existsSync(podDir)) fs.mkdirSync(podDir, { recursive: true });
const podStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, podDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 8)}${ext}`);
  },
});
const podUpload = multer({ storage: podStorage, limits: { fileSize: 15 * 1024 * 1024 } }); // 15MB

router.get('/stats/kpis', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }
    const trips = await prisma.trip.findMany({ where });
    const completed = trips.filter((t: any) => t.status === 'completed');
    return res.json({
      total: trips.length, completed: completed.length,
      totalTonnage: completed.reduce((s: number, t: any) => s+(t.deliveredQuantityTons||0), 0),
      totalRevenue: completed.reduce((s: number, t: any) => s+(t.revenue||0), 0),
      avgCycleMinutes: completed.filter((t: any) => t.totalCycleMinutes).length > 0
        ? completed.filter((t: any) => t.totalCycleMinutes).reduce((s: number, t: any) => s+(t.totalCycleMinutes||0), 0) / completed.filter((t: any) => t.totalCycleMinutes).length
        : 0,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Auto truck assignment suggestion (#3)
router.get('/suggest-assignment', async (req: AuthRequest, res: Response) => {
  try {
    const { orderType, plannedQuantityTons, pickupLocation, deliveryLocation, tripDate } = req.query as any;
    const date = tripDate ? new Date(tripDate) : new Date();
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
    const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59);

    // Get busy vehicles/drivers on this date
    const busyTrips = await prisma.trip.findMany({
      where: { tripDate: { gte: dayStart, lte: dayEnd }, status: { notIn: ['completed', 'cancelled'] } },
      select: { vehicleId: true, driverId: true },
    });
    const busyVehicleIds = new Set(busyTrips.map(t => t.vehicleId));
    const busyDriverIds = new Set(busyTrips.map(t => t.driverId));

    // Available vehicles
    const vehicles = await prisma.vehicle.findMany({
      where: { status: 'active', id: { notIn: Array.from(busyVehicleIds) } },
      select: { id: true, plateNumber: true, make: true, model: true, category: true, capacityTons: true },
    });

    // Score vehicles
    const scoredVehicles = [];
    for (const v of vehicles) {
      let score = 50; // base
      // Capacity fit: higher score if capacity matches planned qty (not too big, not too small)
      if (plannedQuantityTons && v.capacityTons >= Number(plannedQuantityTons)) score += 20;
      if (plannedQuantityTons && v.capacityTons < Number(plannedQuantityTons)) score -= 30;
      // Route familiarity: recent trips to same route
      if (pickupLocation || deliveryLocation) {
        const routeTrips = await prisma.trip.count({
          where: { vehicleId: v.id, status: 'completed',
            ...(pickupLocation ? { pickupLocation: { contains: pickupLocation } } : {}),
            ...(deliveryLocation ? { deliveryLocation: { contains: deliveryLocation } } : {}) },
        });
        score += Math.min(routeTrips * 5, 20);
      }
      // Fuel efficiency bonus
      const fuelLogs = await prisma.fuelLog.findMany({ where: { vehicleId: v.id }, select: { liters: true }, take: 10 });
      if (fuelLogs.length > 0) score += 5;
      scoredVehicles.push({ ...v, score: Math.min(100, Math.max(0, score)) });
    }
    scoredVehicles.sort((a, b) => b.score - a.score);

    // Available drivers
    const drivers = await prisma.employee.findMany({
      where: { role: 'driver', status: 'active', id: { notIn: Array.from(busyDriverIds) } },
      select: { id: true, firstName: true, lastName: true },
    });

    const scoredDrivers = [];
    for (const d of drivers) {
      let score = 50;
      // Route experience
      if (deliveryLocation) {
        const routeExp = await prisma.trip.count({
          where: { driverId: d.id, status: 'completed', deliveryLocation: { contains: deliveryLocation } },
        });
        score += Math.min(routeExp * 5, 25);
      }
      // Workload balance (fewer trips this week = higher)
      const weekStart = new Date(date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const weekTrips = await prisma.trip.count({
        where: { driverId: d.id, tripDate: { gte: weekStart } },
      });
      score += Math.max(0, 20 - weekTrips * 4);
      scoredDrivers.push({ ...d, name: `${d.firstName} ${d.lastName}`, score: Math.min(100, Math.max(0, score)) });
    }
    scoredDrivers.sort((a, b) => b.score - a.score);

    return res.json({
      vehicles: scoredVehicles.slice(0, 5),
      drivers: scoredDrivers.slice(0, 5),
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Trip time analytics (#8)
router.get('/stats/time-analytics', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, driverId, from, to } = req.query as any;
    const where: any = { status: 'completed' };
    if (vehicleId) where.vehicleId = vehicleId;
    if (driverId) where.driverId = driverId;
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }

    const trips = await prisma.trip.findMany({
      where,
      select: {
        id: true, tripNumber: true, pickupLocation: true, deliveryLocation: true,
        loadingStartTime: true, loadingEndTime: true, departureTime: true,
        arrivalAtDelivery: true, unloadingStartTime: true, unloadingEndTime: true,
        totalCycleMinutes: true, vehicleId: true, driverId: true,
        vehicle: { select: { plateNumber: true } },
        driver: { select: { firstName: true, lastName: true } },
      },
    });

    const calcMins = (a: any, b: any) => a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000) : null;

    // Per-trip breakdown
    const tripAnalytics = trips.map(t => {
      const loadingMin = calcMins(t.loadingStartTime, t.loadingEndTime);
      const travelMin = calcMins(t.departureTime, t.arrivalAtDelivery);
      const unloadingMin = calcMins(t.unloadingStartTime, t.unloadingEndTime);
      const total = t.totalCycleMinutes || null;
      const waitMin = total && loadingMin && travelMin && unloadingMin
        ? Math.max(0, total - loadingMin - travelMin - unloadingMin) : null;
      return {
        tripNumber: t.tripNumber,
        route: `${t.pickupLocation} → ${t.deliveryLocation}`,
        vehiclePlate: t.vehicle?.plateNumber,
        driverName: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : null,
        driverId: t.driverId, vehicleId: t.vehicleId,
        loadingMin, travelMin, unloadingMin, waitMin, totalMin: total,
      };
    });

    // Aggregate by route
    const routeMap: any = {};
    for (const t of tripAnalytics) {
      if (!routeMap[t.route]) routeMap[t.route] = { route: t.route, trips: 0, loadingArr: [], travelArr: [], unloadingArr: [], waitArr: [], totalArr: [] };
      routeMap[t.route].trips++;
      if (t.loadingMin) routeMap[t.route].loadingArr.push(t.loadingMin);
      if (t.travelMin) routeMap[t.route].travelArr.push(t.travelMin);
      if (t.unloadingMin) routeMap[t.route].unloadingArr.push(t.unloadingMin);
      if (t.waitMin) routeMap[t.route].waitArr.push(t.waitMin);
      if (t.totalMin) routeMap[t.route].totalArr.push(t.totalMin);
    }
    const avg = (arr: number[]) => arr.length > 0 ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    const byRoute = Object.values(routeMap).map((r: any) => ({
      route: r.route, trips: r.trips,
      avgLoading: avg(r.loadingArr), avgTravel: avg(r.travelArr),
      avgUnloading: avg(r.unloadingArr), avgWait: avg(r.waitArr), avgTotal: avg(r.totalArr),
    }));

    // Aggregate by driver
    const driverMap: any = {};
    for (const t of tripAnalytics) {
      if (!t.driverId) continue;
      if (!driverMap[t.driverId]) driverMap[t.driverId] = { driverId: t.driverId, name: t.driverName, trips: 0, totalArr: [], loadingArr: [], travelArr: [] };
      driverMap[t.driverId].trips++;
      if (t.totalMin) driverMap[t.driverId].totalArr.push(t.totalMin);
      if (t.loadingMin) driverMap[t.driverId].loadingArr.push(t.loadingMin);
      if (t.travelMin) driverMap[t.driverId].travelArr.push(t.travelMin);
    }
    const byDriver = Object.values(driverMap).map((d: any) => ({
      driverId: d.driverId, name: d.name, trips: d.trips,
      avgCycle: avg(d.totalArr), avgLoading: avg(d.loadingArr), avgTravel: avg(d.travelArr),
    })).sort((a: any, b: any) => a.avgCycle - b.avgCycle);

    // Overall summary
    const allTotals = tripAnalytics.filter(t => t.totalMin).map(t => t.totalMin!);
    const allLoading = tripAnalytics.filter(t => t.loadingMin).map(t => t.loadingMin!);
    const allTravel = tripAnalytics.filter(t => t.travelMin).map(t => t.travelMin!);
    const allUnloading = tripAnalytics.filter(t => t.unloadingMin).map(t => t.unloadingMin!);

    return res.json({
      summary: {
        totalTrips: trips.length,
        avgCycleMin: avg(allTotals), avgLoadingMin: avg(allLoading),
        avgTravelMin: avg(allTravel), avgUnloadingMin: avg(allUnloading),
      },
      byRoute: byRoute.sort((a: any, b: any) => b.trips - a.trips),
      byDriver,
      trips: tripAnalytics.slice(0, 50),
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, driverId, status, from, to, page='1', limit='20' } = req.query as any;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (driverId) where.driverId = driverId;
    if (status) where.status = status;
    if (from || to) { where.tripDate = {}; if (from) where.tripDate.gte = new Date(from); if (to) where.tripDate.lte = new Date(to); }
    const skip = (Number(page)-1)*Number(limit);
    const [trips, total] = await Promise.all([
      prisma.trip.findMany({ where, skip, take: Number(limit), orderBy: { tripDate: 'desc' },
        include: { vehicle: { select: { plateNumber: true, make: true } },
          driver: { select: { firstName: true, lastName: true } },
          customer: { select: { companyName: true } },
          order: { select: { orderNumber: true } } } }),
      prisma.trip.count({ where }) ]);
    return res.json({ trips, total, page: Number(page), limit: Number(limit) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const trip = await prisma.trip.findUnique({ where: { id: req.params.id },
      include: { vehicle: true, driver: true, helper: true, customer: true,
        order: { include: { customer: true } }, advances: true, fuelLogs: true,
        statusHistory: { orderBy: { changedAt: 'desc' } } } });
    if (!trip) return res.status(404).json({ error: 'Not found' });
    return res.json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

/**
 * Resolve a vehicleId that may come in as:
 *   - A normal Vehicle UUID  → returned unchanged
 *   - A string like "rental:<rentalVehicleId>" → look up the RentalVehicle,
 *     find-or-create a mirror Vehicle row (ownership='rented'), and return that Vehicle id.
 * This lets dispatchers pick rental vehicles from the same dropdown as own fleet.
 */
async function resolveVehicleId(rawId: string): Promise<string> {
  if (!rawId || !rawId.startsWith('rental:')) return rawId;
  const rentalId = rawId.slice('rental:'.length);
  const rv = await (prisma as any).rentalVehicle.findUnique({
    where: { id: rentalId },
    include: { owner: true },
  });
  if (!rv) throw new Error(`Rental vehicle ${rentalId} not found`);
  // Try to find an already-imported mirror
  const existing = await (prisma as any).vehicle.findFirst({
    where: { OR: [{ sourceRentalVehicleId: rentalId }, { plateNumber: rv.plateNumber }] },
  });
  if (existing) {
    // If it was created manually (not via this import) still link it now so future lookups are O(1)
    if (!existing.sourceRentalVehicleId) {
      await prisma.vehicle.update({
        where: { id: existing.id },
        data: { sourceRentalVehicleId: rentalId, ownership: 'rented', ownerName: rv.owner?.name || null },
      });
    }
    return existing.id;
  }
  // Create a fresh mirror Vehicle row
  const created = await prisma.vehicle.create({
    data: {
      plateNumber: rv.plateNumber,
      category: rv.vehicleType || 'rental',
      vehicleType: 'standalone',
      make: rv.owner?.name ? `Rental (${rv.owner.name})` : 'Rental',
      model: rv.vehicleType || '-',
      year: new Date().getFullYear(),
      capacityTons: rv.capacityTons || 0,
      status: 'active',
      ownership: 'rented',
      ownerName: rv.owner?.name || null,
      sourceRentalVehicleId: rentalId,
    } as any,
  });
  return created.id;
}

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { orderId, driverId, helperId, customerId, orderType,
      pickupLocation, deliveryLocation, plannedQuantityTons, ratePerTon, tripDate } = req.body;
    let { vehicleId } = req.body;
    if (!vehicleId || !driverId || !pickupLocation || !deliveryLocation || !plannedQuantityTons || !ratePerTon)
      return res.status(400).json({ error: 'vehicleId, driverId, pickupLocation, deliveryLocation, plannedQuantityTons, ratePerTon required' });

    // Resolve rental:<id> → real Vehicle id (auto-imports if needed)
    try { vehicleId = await resolveVehicleId(vehicleId); }
    catch (e: any) { return res.status(400).json({ error: e.message }); }

    // Check if vehicle is compliance-locked
    const checkVehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } }) as any;
    if (checkVehicle?.complianceLocked) {
      return res.status(400).json({ error: `Cannot assign trip: vehicle ${checkVehicle.plateNumber} is compliance-locked (${checkVehicle.lockReason}).` });
    }

    const count = await prisma.trip.count();
    const tripNumber = 'TRP-' + new Date().getFullYear() + '-' + String(count+1).padStart(6,'0');
    const trip = await prisma.$transaction(async (tx: any) => {
      const t = await tx.trip.create({ data: {
        tripNumber, orderId: orderId||null, vehicleId, driverId, helperId: helperId||null,
        customerId: customerId||null, orderType: orderType||'cement',
        pickupLocation, deliveryLocation,
        plannedQuantityTons: Number(plannedQuantityTons), ratePerTon: Number(ratePerTon),
        tripDate: tripDate ? new Date(tripDate) : new Date(),
        status: 'planned', createdById: req.user?.id } });
      await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'active' } });
      return t;
    });
    // Telegram: notify new trip
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { plateNumber: true } });
    const driver = await prisma.employee.findUnique({ where: { id: driverId }, select: { firstName: true, lastName: true } });
    sendNotification('info', 'trip',
      `New Trip ${trip.tripNumber}`,
      `${vehicle?.plateNumber || 'N/A'} | ${driver?.firstName} ${driver?.lastName}\n${pickupLocation} \u2192 ${deliveryLocation}\n${plannedQuantityTons} tons @ ${ratePerTon}/ton`
    ).catch(() => {});

    return res.status(201).json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['vehicleId','driverId','helperId','customerId','orderType','pickupLocation','deliveryLocation','notes','tripAttachments',
      'gpsArrivalAtLoading','gpsArrivalAtUnloading'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['plannedQuantityTons','loadedQuantityTons','ratePerTon','deliveredQuantityTons'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    for (const f of ['gpsArrivalAtLoadingTime','gpsLoadingCompletionTime','gpsArrivalAtUnloadingTime','gpsUnloadingExitTime'])
      if (req.body[f]) data[f] = new Date(req.body[f]);
    if (req.body.tripDate) data.tripDate = new Date(req.body.tripDate);
    const trip = await prisma.trip.update({ where: { id: req.params.id }, data });
    return res.json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Valid status transitions
const STATUS_TRANSITIONS: Record<string, string[]> = {
  planned: ['dispatched', 'cancelled'],
  dispatched: ['loading', 'cancelled'],
  loading: ['in_transit', 'cancelled'],
  in_transit: ['delivering', 'cancelled'],
  delivering: ['completed', 'cancelled'],
};

router.put('/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { status, note } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });

    const existing = await prisma.trip.findUnique({ where: { id: req.params.id } }) as any;
    if (!existing) return res.status(404).json({ error: 'Trip not found' });

    // Enforce valid status transitions
    const allowed = STATUS_TRANSITIONS[existing.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from '${existing.status}' to '${status}'. Allowed: ${allowed.join(', ')}` });
    }

    // Control: no dispatch without order
    if (status === 'dispatched' && !existing.orderId) {
      return res.status(400).json({ error: 'Cannot dispatch trip without an order number. Assign an order first.' });
    }

    // Control: no dispatch if vehicle is compliance-locked
    if (status === 'dispatched') {
      const vehicle = await prisma.vehicle.findUnique({ where: { id: existing.vehicleId } }) as any;
      if (vehicle?.complianceLocked) {
        return res.status(400).json({ error: `Cannot dispatch: vehicle ${vehicle.plateNumber} is compliance-locked (${vehicle.lockReason}). Renew documents first.` });
      }
    }

    // Control: no loading without assigned vehicle + driver
    if (status === 'loading' && (!existing.vehicleId || !existing.driverId)) {
      return res.status(400).json({ error: 'Cannot start loading without assigned vehicle and driver.' });
    }

    // B5: Strict data gating before status transitions
    if (status === 'dispatched') {
      // A4: Customer credit block on dispatch
      if (existing.orderId) {
        const order = await prisma.customerOrder.findUnique({ where: { id: existing.orderId }, include: { customer: true } }) as any;
        if (order?.customer?.dispatchBlocked) {
          return res.status(400).json({ error: `Cannot dispatch: customer ${order.customer.companyName} is blocked (${order.customer.blockReason || 'overdue balance'}).` });
        }
        if (order?.customer && order.customer.creditLimit > 0 && order.customer.outstandingBalance > order.customer.creditLimit) {
          if (!req.body.ownerOverride || req.user?.role !== 'owner') {
            return res.status(400).json({ error: `Cannot dispatch: customer ${order.customer.companyName} credit limit exceeded (outstanding: ${order.customer.outstandingBalance}, limit: ${order.customer.creditLimit}). Owner override required.` });
          }
        }
      }
    }
    if (status === 'in_transit') {
      // Must have loaded quantity before moving to in_transit
      const loadedQty = req.body.loadedQuantityTons || existing.loadedQuantityTons;
      if (!loadedQty || loadedQty <= 0) {
        return res.status(400).json({ error: 'Cannot move to in_transit: loaded quantity must be recorded first. Provide loadedQuantityTons.' });
      }
    }
    if (status === 'completed') {
      // Must have delivered quantity, shortage calc, unloading record
      const deliveredQty = req.body.deliveredQuantityTons || existing.deliveredQuantityTons;
      if (!deliveredQty || deliveredQty <= 0) {
        return res.status(400).json({ error: 'Cannot complete trip: delivered quantity must be recorded. Use the close endpoint or provide deliveredQuantityTons.' });
      }
    }

    const data: any = { status };
    // Accept GPS fields if provided (B4)
    for (const gf of ['gpsArrivalAtLoading','gpsArrivalAtUnloading']) {
      if (req.body[gf]) data[gf] = req.body[gf];
    }
    for (const gf of ['gpsArrivalAtLoadingTime','gpsLoadingCompletionTime','gpsArrivalAtUnloadingTime','gpsUnloadingExitTime']) {
      if (req.body[gf]) data[gf] = new Date(req.body[gf]);
    }
    // Accept loadedQuantityTons if provided during status change
    if (req.body.loadedQuantityTons) data.loadedQuantityTons = Number(req.body.loadedQuantityTons);

    if (status === 'dispatched') { data.dispatchedAt = new Date(); data.dispatchedBy = req.user?.id; }
    if (status === 'loading') {
      data.loadingStartTime = new Date(); data.loadedAt = new Date();
      if (req.body.gpsArrivalAtLoadingTime) data.gpsArrivalAtLoadingTime = new Date(req.body.gpsArrivalAtLoadingTime);
      else data.gpsArrivalAtLoadingTime = new Date();
    }
    if (status === 'in_transit') data.departureTime = new Date();
    if (status === 'delivering') {
      data.arrivalAtDelivery = new Date();
      if (req.body.gpsArrivalAtUnloadingTime) data.gpsArrivalAtUnloadingTime = new Date(req.body.gpsArrivalAtUnloadingTime);
      else data.gpsArrivalAtUnloadingTime = new Date();
    }
    if (status === 'completed') {
      data.unloadingEndTime = new Date();
      if (req.body.gpsUnloadingExitTime) data.gpsUnloadingExitTime = new Date(req.body.gpsUnloadingExitTime);
      else data.gpsUnloadingExitTime = new Date();
      // Calculate unloading duration if we have arrival at unloading
      const arrivalTime = data.gpsArrivalAtUnloadingTime || existing.gpsArrivalAtUnloadingTime;
      const exitTime = data.gpsUnloadingExitTime || new Date();
      if (arrivalTime) {
        data.unloadingDurationMinutes = Math.round((exitTime.getTime() - new Date(arrivalTime).getTime()) / 60000);
      }
    }

    // Map trip status to vehicle operationalStatus
    const vehicleStatusMap: Record<string, string> = {
      dispatched: 'on_trip', loading: 'loading', in_transit: 'on_trip',
      delivering: 'on_trip', completed: 'idle', cancelled: 'idle',
    };

    const trip = await prisma.$transaction(async (tx: any) => {
      const t = await tx.trip.update({ where: { id: req.params.id }, data });
      // Record status history
      await tx.tripStatusHistory.create({ data: {
        tripId: req.params.id, fromStatus: existing.status, toStatus: status,
        changedBy: req.user?.id, note: note || null,
      }});
      // Update vehicle operationalStatus
      if (vehicleStatusMap[status]) {
        const vehicle = await tx.vehicle.findUnique({ where: { id: existing.vehicleId } }) as any;
        if (vehicle && !vehicle.complianceLocked) {
          await tx.vehicle.update({ where: { id: existing.vehicleId }, data: { operationalStatus: vehicleStatusMap[status] } });
        }
      }
      return t;
    });
    return res.json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/:id/close', async (req: AuthRequest, res: Response) => {
  try {
    const { deliveredQuantityTons, notes, customerDeducted, customerDeductionAmount, driverPenaltyAmount } = req.body;
    const existing = await prisma.trip.findUnique({ where: { id: req.params.id } }) as any;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const loaded = existing.loadedQuantityTons || existing.plannedQuantityTons;
    const delivered = Number(deliveredQuantityTons);
    const shortage = Math.max(0, loaded - delivered);
    const revenue = delivered * existing.ratePerTon;
    const shortageDeduction = shortage * existing.ratePerTon;
    // B6: Separate customer deduction and driver penalty
    const custDeducted = customerDeducted === true || customerDeducted === 'true';
    const custDeductionAmt = custDeducted ? Number(customerDeductionAmount || shortageDeduction) : 0;
    const driverPenalty = Number(driverPenaltyAmount || shortageDeduction);
    const trip = await prisma.$transaction(async (tx: any) => {
      const t = await tx.trip.update({ where: { id: req.params.id }, data: {
        deliveredQuantityTons: delivered, shortage, revenue, shortageDeduction,
        customerDeducted: custDeducted, customerDeductionAmount: custDeductionAmt,
        driverPenaltyAmount: shortage > 0 ? driverPenalty : 0,
        status: 'completed', notes: notes||null,
        totalCycleMinutes: existing.departureTime
          ? Math.round((Date.now() - new Date(existing.departureTime).getTime()) / 60000) : null,
        unloadingEndTime: new Date() } });
      await tx.vehicle.update({ where: { id: existing.vehicleId }, data: { status: 'active', operationalStatus: 'idle' } });
      // Record status history
      await tx.tripStatusHistory.create({ data: {
        tripId: req.params.id, fromStatus: existing.status, toStatus: 'completed',
        changedBy: req.user?.id, note: notes || null,
      }});
      // Update order totals
      if (existing.orderId) {
        const completedTrips = await tx.trip.findMany({
          where: { orderId: existing.orderId, status: 'completed' },
          select: { deliveredQuantityTons: true },
        });
        const totalDelivered = completedTrips.reduce((s: number, t: any) => s + (t.deliveredQuantityTons || 0), 0) + delivered;
        const order = await tx.customerOrder.findUnique({ where: { id: existing.orderId } }) as any;
        const remainingQty = Math.max(0, (order?.quantity || 0) - totalDelivered);
        const allTrips = await tx.trip.count({ where: { orderId: existing.orderId, status: { not: 'cancelled' } } });
        const allCompleted = completedTrips.length + 1;
        const orderData: any = {
          totalDelivered, totalTrips: allTrips, remainingQty,
        };
        if (allCompleted >= allTrips) orderData.status = 'delivered';
        await tx.customerOrder.update({ where: { id: existing.orderId }, data: orderData });
      }
      return t;
    });
    // Auto-create shortage penalty if shortage > 0 and order exists
    if (shortage > 0 && existing.orderId) {
      await prisma.orderPenalty.create({
        data: {
          orderId: existing.orderId,
          tripId: existing.id,
          type: 'shortage',
          description: `Auto-detected shortage on trip ${existing.tripNumber}: ${shortage.toFixed(2)} tons`,
          quantityAffected: shortage,
          rateApplied: existing.ratePerTon,
          amount: shortageDeduction,
          status: 'pending',
        },
      });
      // Create alert for significant shortage (>5%)
      const loaded = existing.loadedQuantityTons || existing.plannedQuantityTons || 1;
      const shortagePct = (shortage / loaded) * 100;
      if (shortagePct >= 5) {
        createAlert({
          type: 'qty_mismatch', severity: shortagePct >= 10 ? 'critical' : 'urgent',
          title: `Qty Mismatch: ${existing.tripNumber}`,
          message: `Shortage of ${shortage.toFixed(2)} tons (${shortagePct.toFixed(1)}%) on trip ${existing.tripNumber}`,
          entityType: 'trip', entityId: existing.id,
        }).catch(() => {});
      }
    }

    // B6: Auto-create driver ledger debit for shortage penalty (deducted from next per diem)
    if (shortage > 0 && driverPenalty > 0) {
      const currentLedger = await prisma.driverLedgerEntry.findMany({
        where: { driverId: existing.driverId }, orderBy: { createdAt: 'desc' }, take: 1,
      });
      const prevBalance = (currentLedger[0] as any)?.balance || 0;
      await prisma.driverLedgerEntry.create({ data: {
        driverId: existing.driverId, type: 'debit', category: 'shortage',
        amount: driverPenalty, balance: prevBalance - driverPenalty,
        referenceId: existing.id, referenceType: 'trip',
        description: `Shortage penalty: ${shortage.toFixed(2)} tons on trip ${existing.tripNumber} (ETB ${driverPenalty.toFixed(2)})`,
      }});
    }

    // Telegram: notify trip completed
    const vehicle = await prisma.vehicle.findUnique({ where: { id: existing.vehicleId }, select: { plateNumber: true } });
    if (shortage > 0) {
      sendNotification('urgent', 'trip',
        `Trip ${existing.tripNumber} - SHORTAGE ALERT`,
        `${vehicle?.plateNumber || 'N/A'}\nDelivered: ${delivered} tons | Shortage: ${shortage} tons\nDeduction: ${shortageDeduction.toFixed(2)} ETB`
      ).catch(() => {});
    } else {
      sendNotification('info', 'trip',
        `Trip ${existing.tripNumber} Completed`,
        `${vehicle?.plateNumber || 'N/A'}\nDelivered: ${delivered} tons | Revenue: ${revenue.toFixed(2)} ETB`
      ).catch(() => {});
    }

    // Auto-post journal entry: DR Receivable, CR Revenue
    if (revenue > 0) {
      postJournalEntry({
        sourceType: 'trip_revenue',
        sourceId: req.params.id,
        amount: revenue,
        description: `Trip ${existing.tripNumber} completed - ${delivered} tons delivered`,
        reference: existing.tripNumber,
        createdBy: req.user?.id,
      }).catch(() => {});
    }

    return res.json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Trip cost calculation (#11)
router.post('/:id/calculate-cost', async (req: AuthRequest, res: Response) => {
  try {
    const trip = await prisma.trip.findUnique({ where: { id: req.params.id },
      include: { vehicle: true, driver: true } }) as any;
    if (!trip) return res.status(404).json({ error: 'Not found' });

    // 1. Fuel cost: sum of fuel logs for this trip
    const fuelLogs = await prisma.fuelLog.findMany({ where: { tripId: trip.id } });
    const allocatedFuelCost = fuelLogs.reduce((s: number, f: any) => s + (f.totalCost || f.liters * f.costPerLiter || 0), 0);

    // 2. Driver cost: daily rate based on salary
    const driverPayroll = trip.driverId ? await prisma.payroll.findFirst({
      where: { employeeId: trip.driverId }, orderBy: { createdAt: 'desc' },
    }) : null;
    const monthlySalary = (driverPayroll as any)?.basicSalary || (trip.driver as any)?.basicSalary || 0;
    const allocatedDriverCost = monthlySalary > 0 ? Math.round(monthlySalary / 26) : 0; // daily rate

    // 3. Maintenance cost: prorated from recent work orders
    const recentMaint = trip.vehicleId ? await prisma.workOrder.findMany({
      where: { vehicleId: trip.vehicleId, status: 'completed' },
      select: { totalCost: true }, take: 10, orderBy: { endTime: 'desc' },
    }) : [];
    const avgMaintPerOrder = recentMaint.length > 0
      ? recentMaint.reduce((s: number, w: any) => s + (w.totalCost || 0), 0) / recentMaint.length : 0;
    const vehicleTripsMonth = trip.vehicleId ? await prisma.trip.count({
      where: { vehicleId: trip.vehicleId, tripDate: { gte: new Date(new Date().setDate(1)) } },
    }) : 1;
    const allocatedMaintenanceCost = Math.round(avgMaintPerOrder / Math.max(vehicleTripsMonth, 1));

    // 4. Depreciation cost: from asset depreciation table
    const depreciation = trip.vehicleId ? await prisma.depreciationEntry.findFirst({
      where: { assetDepreciation: { vehicleId: trip.vehicleId } },
      orderBy: { year: 'desc' }, select: { annualDepreciation: true },
    }) : null;
    const annualDep = (depreciation as any)?.annualDepreciation || 0;
    const allocatedDepreciationCost = Math.round(annualDep / 312); // ~312 working days/year

    const totalTripCost = allocatedFuelCost + allocatedDriverCost + allocatedMaintenanceCost + allocatedDepreciationCost;
    const profitPerTrip = (trip.revenue || 0) - totalTripCost;

    const updated = await prisma.trip.update({ where: { id: req.params.id }, data: {
      allocatedFuelCost, allocatedDriverCost, allocatedMaintenanceCost,
      allocatedDepreciationCost, totalTripCost, profitPerTrip,
    }});

    return res.json({
      trip: updated,
      costBreakdown: {
        fuel: allocatedFuelCost, driver: allocatedDriverCost,
        maintenance: allocatedMaintenanceCost, depreciation: allocatedDepreciationCost,
        total: totalTripCost, revenue: trip.revenue || 0, profit: profitPerTrip,
        margin: trip.revenue ? Math.round(profitPerTrip / trip.revenue * 100) : 0,
      },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Trip cost analysis stats
router.get('/stats/cost-analysis', async (req: AuthRequest, res: Response) => {
  try {
    const trips = await prisma.trip.findMany({
      where: { status: 'completed', totalTripCost: { not: null } },
      select: {
        tripNumber: true, revenue: true, totalTripCost: true, profitPerTrip: true,
        allocatedFuelCost: true, allocatedDriverCost: true,
        allocatedMaintenanceCost: true, allocatedDepreciationCost: true,
        vehicle: { select: { plateNumber: true } },
        driver: { select: { firstName: true, lastName: true } },
      },
      orderBy: { tripDate: 'desc' }, take: 100,
    });

    const totalRevenue = trips.reduce((s, t: any) => s + (t.revenue || 0), 0);
    const totalCost = trips.reduce((s, t: any) => s + (t.totalTripCost || 0), 0);
    const totalFuel = trips.reduce((s, t: any) => s + (t.allocatedFuelCost || 0), 0);
    const totalDriver = trips.reduce((s, t: any) => s + (t.allocatedDriverCost || 0), 0);
    const totalMaint = trips.reduce((s, t: any) => s + (t.allocatedMaintenanceCost || 0), 0);
    const totalDep = trips.reduce((s, t: any) => s + (t.allocatedDepreciationCost || 0), 0);

    return res.json({
      summary: {
        tripsAnalyzed: trips.length, totalRevenue, totalCost,
        totalProfit: totalRevenue - totalCost,
        avgMargin: totalRevenue > 0 ? Math.round((totalRevenue - totalCost) / totalRevenue * 100) : 0,
        costBreakdown: { fuel: totalFuel, driver: totalDriver, maintenance: totalMaint, depreciation: totalDep },
      },
      trips: trips.map((t: any) => ({
        ...t, driverName: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : '-',
        vehiclePlate: t.vehicle?.plateNumber,
        margin: t.revenue ? Math.round(((t.revenue - (t.totalTripCost || 0)) / t.revenue) * 100) : 0,
      })),
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/:id/pod', podUpload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { podFilename, podReference } = req.body as any;
    const file = (req as any).file;
    let fileUrl: string | null = null;
    let savedName: string | null = null;
    if (file) {
      fileUrl = `/uploads/pod/${file.filename}`;
      savedName = file.originalname;
    }
    const ref = podReference || podFilename || savedName || ('pod_' + req.params.id);
    const trip = await prisma.trip.update({ where: { id: req.params.id },
      data: {
        podDocument: ref,
        podUrl: fileUrl || ref,
        podUploadedAt: new Date(),
        podUploadedBy: req.user?.id,
      } });
    return res.json({ trip, message: 'POD uploaded', fileUrl });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/:id/weighbridge', podUpload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { weighbridgeFilename, loadedQuantityTons } = req.body as any;
    const file = (req as any).file;
    const ref = file ? `/uploads/pod/${file.filename}` : (weighbridgeFilename || ('wb_' + req.params.id));
    const data: any = { weighbridgeSlip: ref };
    if (loadedQuantityTons) data.loadedQuantityTons = Number(loadedQuantityTons);
    const trip = await prisma.trip.update({ where: { id: req.params.id }, data });
    return res.json({ trip, message: 'Weighbridge slip uploaded' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delivery confirmation
router.put('/:id/delivery-confirmation', async (req: AuthRequest, res: Response) => {
  try {
    const { customerConfirmationStatus, customerDisputeReason } = req.body;
    if (!customerConfirmationStatus || !['confirmed', 'disputed'].includes(customerConfirmationStatus)) {
      return res.status(400).json({ error: 'customerConfirmationStatus must be "confirmed" or "disputed"' });
    }
    const data: any = {
      customerConfirmationStatus,
      deliveryConfirmedAt: new Date(),
      deliveryConfirmedBy: req.user?.id,
    };
    if (customerConfirmationStatus === 'disputed') data.customerDisputeReason = customerDisputeReason || null;
    const trip = await prisma.trip.update({ where: { id: req.params.id }, data });
    return res.json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// POD aging report
router.get('/reports/pod-aging', async (req: AuthRequest, res: Response) => {
  try {
    const trips = await prisma.trip.findMany({
      where: { status: 'completed', podUrl: null },
      select: {
        id: true, tripNumber: true, deliveryLocation: true, deliveredQuantityTons: true,
        unloadingEndTime: true, createdAt: true, customerConfirmationStatus: true,
        vehicle: { select: { plateNumber: true } },
        driver: { select: { firstName: true, lastName: true } },
        customer: { select: { companyName: true } },
      },
      orderBy: { unloadingEndTime: 'asc' },
    });
    const now = Date.now();
    const aged = trips.map((t: any) => {
      const completedAt = t.unloadingEndTime || t.createdAt;
      const ageDays = Math.floor((now - new Date(completedAt).getTime()) / 86400000);
      return { ...t, ageDays, ageGroup: ageDays <= 3 ? '0-3 days' : ageDays <= 7 ? '4-7 days' : '7+ days' };
    });
    const summary = {
      total: aged.length,
      within3Days: aged.filter((t: any) => t.ageDays <= 3).length,
      within7Days: aged.filter((t: any) => t.ageDays > 3 && t.ageDays <= 7).length,
      over7Days: aged.filter((t: any) => t.ageDays > 7).length,
    };
    return res.json({ summary, trips: aged });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Unconfirmed delivery aging report
router.get('/reports/unconfirmed-aging', async (req: AuthRequest, res: Response) => {
  try {
    const trips = await prisma.trip.findMany({
      where: { status: 'completed', customerConfirmationStatus: 'pending' },
      select: {
        id: true, tripNumber: true, deliveryLocation: true, deliveredQuantityTons: true,
        unloadingEndTime: true, podUrl: true,
        vehicle: { select: { plateNumber: true } },
        driver: { select: { firstName: true, lastName: true } },
        customer: { select: { companyName: true } },
      },
      orderBy: { unloadingEndTime: 'asc' },
    });
    const now = Date.now();
    const aged = trips.map((t: any) => {
      const completedAt = t.unloadingEndTime || new Date();
      const ageDays = Math.floor((now - new Date(completedAt).getTime()) / 86400000);
      return { ...t, ageDays };
    });
    return res.json({ total: aged.length, trips: aged });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Vehicle swap
router.put('/:id/swap-vehicle', async (req: AuthRequest, res: Response) => {
  try {
    const { toVehicleId, reason } = req.body;
    if (!toVehicleId || !reason) return res.status(400).json({ error: 'toVehicleId and reason are required' });

    const trip = await prisma.trip.findUnique({ where: { id: req.params.id } });
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    if (['completed', 'cancelled'].includes(trip.status)) return res.status(400).json({ error: 'Cannot swap vehicle on completed/cancelled trip' });

    const toVehicle = await prisma.vehicle.findUnique({ where: { id: toVehicleId } });
    if (!toVehicle) return res.status(404).json({ error: 'Target vehicle not found' });

    const result = await prisma.$transaction(async (tx: any) => {
      // Log the swap
      await tx.vehicleSwapLog.create({
        data: {
          tripId: trip.id,
          fromVehicleId: trip.vehicleId,
          toVehicleId,
          reason,
          swappedBy: req.user?.id,
        },
      });
      // Update trip
      const updated = await tx.trip.update({
        where: { id: trip.id },
        data: { vehicleId: toVehicleId },
        include: { vehicle: { select: { plateNumber: true } } },
      });
      // Record in status history
      await tx.tripStatusHistory.create({
        data: {
          tripId: trip.id,
          fromStatus: trip.status,
          toStatus: trip.status,
          changedBy: req.user?.id,
          note: `Vehicle swapped: ${trip.vehicleId} -> ${toVehicleId}. Reason: ${reason}`,
        },
      });
      return updated;
    });

    return res.json({ trip: result });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Trip status history
router.get('/:id/status-history', async (req: AuthRequest, res: Response) => {
  try {
    const history = await prisma.tripStatusHistory.findMany({
      where: { tripId: req.params.id },
      orderBy: { changedAt: 'desc' },
    });
    return res.json({ history });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;