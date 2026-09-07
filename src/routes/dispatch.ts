import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { generateTripNumber } from '../utils/sequence-generator';
const router = Router();
router.use(authenticate);

// Get dispatch board data: 7-day grid (vehicles x dates)
router.get('/board', async (req: AuthRequest, res: Response) => {
  try {
    const { startDate } = req.query as any;
    const start = startDate ? new Date(startDate) : new Date();
    start.setHours(0, 0, 0, 0);

    const dates: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      dates.push(d);
    }

    const endDate = new Date(dates[6]);
    endDate.setHours(23, 59, 59);

    // Get all vehicles
    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'scrapped' } },
      select: { id: true, plateNumber: true, make: true, model: true, capacityTons: true, status: true },
      orderBy: { plateNumber: 'asc' },
    });

    // Get trips in date range
    const trips = await prisma.trip.findMany({
      where: { tripDate: { gte: start, lte: endDate }, status: { notIn: ['cancelled'] } },
      select: {
        id: true, tripNumber: true, vehicleId: true, driverId: true, tripDate: true,
        status: true, pickupLocation: true, deliveryLocation: true,
        plannedQuantityTons: true, orderType: true,
        driver: { select: { firstName: true, lastName: true } },
        customer: { select: { companyName: true } },
      },
    });

    // Get maintenance in date range
    const maintenance = await prisma.workOrder.findMany({
      where: {
        OR: [
          { startTime: { gte: start, lte: endDate } },
          { createdAt: { gte: start, lte: endDate }, status: { in: ['open', 'in_progress'] } },
        ],
      },
      select: { id: true, vehicleId: true, startTime: true, createdAt: true, description: true, status: true },
    });

    // Build grid
    const grid = vehicles.map(v => {
      const cells = dates.map(date => {
        const dayStr = date.toISOString().split('T')[0];
        const dayTrips = trips.filter(t => t.vehicleId === v.id &&
          new Date(t.tripDate).toISOString().split('T')[0] === dayStr);
        const dayMaint = maintenance.filter((m: any) => m.vehicleId === v.id &&
          ((m.startTime && new Date(m.startTime).toISOString().split('T')[0] === dayStr) ||
           new Date(m.createdAt).toISOString().split('T')[0] === dayStr));

        let cellStatus = 'available';
        if (dayMaint.length > 0) cellStatus = 'maintenance';
        else if (dayTrips.length > 0) cellStatus = 'trip';
        if (v.status === 'inactive') cellStatus = 'inactive';

        return {
          date: dayStr, status: cellStatus,
          trips: dayTrips.map(t => ({
            id: t.id, tripNumber: t.tripNumber, status: t.status,
            route: `${t.pickupLocation} → ${t.deliveryLocation}`,
            driver: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : '-',
            customer: t.customer?.companyName || '-',
            qty: t.plannedQuantityTons,
          })),
          maintenance: dayMaint.map((m: any) => ({ id: m.id, description: m.description, status: m.status })),
        };
      });
      return { vehicle: v, cells };
    });

    // Pending orders (unassigned)
    const pendingOrders = await prisma.customerOrder.findMany({
      where: { status: { in: ['submitted', 'confirmed'] } },
      include: { customer: { select: { companyName: true } } },
      orderBy: { createdAt: 'asc' }, take: 20,
    });

    // Available drivers
    const busyDriverIds = trips.map(t => t.driverId);
    const availableDrivers = await prisma.employee.findMany({
      where: { role: 'driver', status: 'active' },
      select: { id: true, firstName: true, lastName: true },
    });

    return res.json({
      dates: dates.map(d => d.toISOString().split('T')[0]),
      grid,
      pendingOrders: pendingOrders.map(o => ({
        id: o.id, orderNumber: (o as any).orderNumber, customer: o.customer?.companyName,
        orderType: o.orderType, quantity: o.quantity,
        pickup: o.pickupLocation, delivery: o.deliveryLocation,
        requiredDate: (o as any).requiredDeliveryDate,
      })),
      availableDrivers: availableDrivers.map(d => ({
        id: d.id, name: `${d.firstName} ${d.lastName}`,
        busy: busyDriverIds.includes(d.id),
      })),
      summary: {
        totalVehicles: vehicles.length,
        activeVehicles: vehicles.filter(v => v.status === 'active').length,
        tripsScheduled: trips.length,
        pendingOrdersCount: pendingOrders.length,
      },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Quick assign: create trip from dispatch board
router.post('/quick-assign', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, driverId, orderId, pickupLocation, deliveryLocation,
      plannedQuantityTons, ratePerTon, orderType, tripDate, customerId } = req.body;
    if (!vehicleId || !driverId) return res.status(400).json({ error: 'vehicleId, driverId required' });
    const tripNumber = await generateTripNumber();
    const trip = await prisma.trip.create({ data: {
      tripNumber, vehicleId, driverId,
      orderId: orderId || null, customerId: customerId || null,
      orderType: orderType || 'cement',
      pickupLocation: pickupLocation || 'TBD', deliveryLocation: deliveryLocation || 'TBD',
      plannedQuantityTons: Number(plannedQuantityTons) || 0,
      ratePerTon: Number(ratePerTon) || 0,
      tripDate: tripDate ? new Date(tripDate) : new Date(),
      status: 'planned', createdById: req.user?.id,
    }});
    if (orderId) {
      await prisma.customerOrder.update({ where: { id: orderId }, data: { status: 'scheduled' } });
    }
    return res.status(201).json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
