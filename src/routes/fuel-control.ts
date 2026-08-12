import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

// ════════════════════════════════════════════════════════════════════════════
// FUEL STANDARDS
// ════════════════════════════════════════════════════════════════════════════
router.get('/standards', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, route } = req.query as Record<string, string>;
    const where: any = { isActive: true };
    if (vehicleId) where.vehicleId = vehicleId;
    if (route) where.route = { contains: route };
    const standards = await prisma.fuelStandard.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { plateNumber: true, category: true } } }
    });
    return res.json({ standards });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/standards', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, vehicleCategory, route, standardLiters, standardKmPerLiter, supplierId, notes } = req.body;
    if (!standardLiters && !standardKmPerLiter) return res.status(400).json({ error: 'standardLiters or standardKmPerLiter required' });
    const standard = await prisma.fuelStandard.create({
      data: {
        vehicleId: vehicleId || null, vehicleCategory: vehicleCategory || null,
        route: route || null,
        standardLiters: Number(standardLiters) || 0,
        standardKmPerLiter: standardKmPerLiter ? Number(standardKmPerLiter) : null,
        supplierId: supplierId || null, notes
      }
    });
    return res.status(201).json({ standard });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/standards/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    if (req.body.standardLiters !== undefined) data.standardLiters = Number(req.body.standardLiters);
    if (req.body.standardKmPerLiter !== undefined) data.standardKmPerLiter = Number(req.body.standardKmPerLiter);
    if (req.body.isActive !== undefined) data.isActive = req.body.isActive;
    if (req.body.notes !== undefined) data.notes = req.body.notes;
    const standard = await prisma.fuelStandard.update({ where: { id: req.params.id }, data });
    return res.json({ standard });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FUEL VARIANCE REPORT
// ════════════════════════════════════════════════════════════════════════════
router.get('/variance', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, vehicleId } = req.query as Record<string, string>;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (from || to) {
      where.date = {};
      if (from) where.date.gte = new Date(from);
      if (to) where.date.lte = new Date(to);
    }

    const fuelLogs = await prisma.fuelLog.findMany({
      where, orderBy: { date: 'desc' },
      include: {
        vehicle: { select: { plateNumber: true, category: true } },
        trip: { select: { tripNumber: true, pickupLocation: true, deliveryLocation: true } },
        driver: { select: { firstName: true, lastName: true } }
      }
    });

    const standards = await prisma.fuelStandard.findMany({ where: { isActive: true } });

    const enriched = fuelLogs.map((log: any) => {
      // Find matching standard
      const route = log.trip ? `${log.trip.pickupLocation} -> ${log.trip.deliveryLocation}` : null;
      const std = standards.find((s: any) =>
        (s.vehicleId && s.vehicleId === log.vehicleId) ||
        (s.route && route && s.route === route) ||
        (s.vehicleCategory && s.vehicleCategory === log.vehicle?.category)
      );

      const standardLiters = std?.standardLiters || null;
      const variance = standardLiters ? log.liters - standardLiters : null;
      const variancePct = standardLiters ? ((log.liters - standardLiters) / standardLiters * 100) : null;

      return {
        ...log,
        route,
        standardLiters,
        variance: variance ? Number(variance.toFixed(1)) : null,
        variancePct: variancePct ? Number(variancePct.toFixed(1)) : null,
        isExcess: variance !== null && variance > 0
      };
    });

    // Summary by vehicle
    const vehicleSummary: any = {};
    for (const log of enriched) {
      const plate = log.vehicle?.plateNumber || 'Unknown';
      if (!vehicleSummary[plate]) vehicleSummary[plate] = { plate, totalLiters: 0, totalCost: 0, totalVariance: 0, count: 0 };
      vehicleSummary[plate].totalLiters += log.liters;
      vehicleSummary[plate].totalCost += log.totalCost;
      if (log.variance !== null) { vehicleSummary[plate].totalVariance += log.variance; vehicleSummary[plate].count++; }
    }

    return res.json({
      fuelLogs: enriched,
      vehicleSummary: Object.values(vehicleSummary),
      totalLiters: enriched.reduce((s: number, l: any) => s + l.liters, 0),
      totalCost: enriched.reduce((s: number, l: any) => s + l.totalCost, 0),
      excessCount: enriched.filter((l: any) => l.isExcess).length
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FUEL LOGS (enhanced with driver/trip)
// ════════════════════════════════════════════════════════════════════════════
router.get('/logs', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, driverId, from, to, page = '1', limit = '50' } = req.query as Record<string, string>;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (driverId) where.driverId = driverId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to); }
    const skip = (Number(page) - 1) * Number(limit);
    const [logs, total] = await Promise.all([
      prisma.fuelLog.findMany({
        where, skip, take: Number(limit), orderBy: { date: 'desc' },
        include: {
          vehicle: { select: { plateNumber: true } },
          trip: { select: { tripNumber: true } },
          driver: { select: { firstName: true, lastName: true } }
        }
      }),
      prisma.fuelLog.count({ where })
    ]);
    return res.json({ logs, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
