import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

// GET /vehicles/fleet-board -- must precede /:id
router.get('/fleet-board', async (req: AuthRequest, res: Response) => {
  try {
    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      include: {
        assignedDriver: { select: { id: true, firstName: true, lastName: true } },
        trips: {
          where: { status: { notIn: ['completed', 'cancelled'] } },
          take: 1, orderBy: { createdAt: 'desc' },
          select: { id: true, tripNumber: true, status: true, pickupLocation: true, deliveryLocation: true, order: { select: { orderNumber: true } } },
        },
        workOrders: {
          where: { status: { in: ['pending', 'in_progress'] } },
          take: 1, orderBy: { createdAt: 'desc' },
          select: { id: true, description: true, status: true },
        },
      },
      orderBy: { plateNumber: 'asc' },
    });

    const board = vehicles.map((v: any) => ({
      id: v.id, plateNumber: v.plateNumber, make: v.make, model: v.model,
      category: v.category, status: v.status,
      operationalStatus: v.operationalStatus,
      complianceLocked: v.complianceLocked, lockReason: v.lockReason, lockedAt: v.lockedAt,
      assignedDriver: v.assignedDriver,
      currentTrip: v.trips[0] || null,
      currentWorkOrder: v.workOrders[0] || null,
      insuranceExpiry: v.insuranceExpiry, inspectionExpiry: v.inspectionExpiry, permitExpiry: v.permitExpiry,
      lastKnownLocation: v.lastKnownLocation, lastLocationAt: v.lastLocationAt,
      capacityTons: v.capacityTons, currentKm: v.currentKm,
    }));

    const summary = {
      total: board.length,
      idle: board.filter((v: any) => v.operationalStatus === 'idle').length,
      onTrip: board.filter((v: any) => v.operationalStatus === 'on_trip').length,
      loading: board.filter((v: any) => v.operationalStatus === 'loading').length,
      maintenance: board.filter((v: any) => v.operationalStatus === 'maintenance').length,
      locked: board.filter((v: any) => v.complianceLocked).length,
    };

    return res.json({ vehicles: board, summary });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// POST /vehicles/:id/compliance-check -- must precede /:id (uses specific path)
router.post('/compliance-check-all', async (req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      select: { id: true, plateNumber: true, insuranceExpiry: true, inspectionExpiry: true, permitExpiry: true, complianceLocked: true },
    });

    const results: any[] = [];
    for (const v of vehicles) {
      const reasons: string[] = [];
      if (v.insuranceExpiry && new Date(v.insuranceExpiry) <= now) reasons.push('Insurance expired');
      if (v.inspectionExpiry && new Date(v.inspectionExpiry) <= now) reasons.push('Inspection expired');
      if (v.permitExpiry && new Date(v.permitExpiry) <= now) reasons.push('Permit expired');

      if (reasons.length > 0 && !v.complianceLocked) {
        await prisma.vehicle.update({
          where: { id: v.id },
          data: { complianceLocked: true, lockReason: reasons.join('; '), lockedAt: now, operationalStatus: 'locked' },
        });
        await prisma.auditLog.create({ data: {
          userId: req.user?.id, action: 'compliance_lock', entityType: 'vehicle',
          entityId: v.id, details: JSON.stringify({ reasons, plateNumber: v.plateNumber }),
        }});
        results.push({ plateNumber: v.plateNumber, action: 'locked', reasons });
      } else if (reasons.length === 0 && v.complianceLocked) {
        // Auto-unlock if all documents renewed
        await prisma.vehicle.update({
          where: { id: v.id },
          data: { complianceLocked: false, lockReason: null, lockedAt: null, operationalStatus: 'idle' },
        });
        results.push({ plateNumber: v.plateNumber, action: 'unlocked', reasons: ['All documents valid'] });
      } else if (reasons.length > 0 && v.complianceLocked) {
        results.push({ plateNumber: v.plateNumber, action: 'already_locked', reasons });
      } else {
        results.push({ plateNumber: v.plateNumber, action: 'compliant', reasons: [] });
      }
    }

    return res.json({
      results,
      locked: results.filter(r => r.action === 'locked').length,
      unlocked: results.filter(r => r.action === 'unlocked').length,
      alreadyLocked: results.filter(r => r.action === 'already_locked').length,
      compliant: results.filter(r => r.action === 'compliant').length,
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// GET /vehicles/stats/overview -- must precede /:id
router.get('/stats/overview', async (req: AuthRequest, res: Response) => {
  try {
    const [total, active, onTrip, inMaintenance, inactive] = await Promise.all([
      prisma.vehicle.count(),
      prisma.vehicle.count({ where: { status: 'active' } }),
      prisma.vehicle.count({ where: { status: 'on_trip' } }),
      prisma.vehicle.count({ where: { status: 'maintenance' } }),
      prisma.vehicle.count({ where: { status: 'inactive' } }),
    ]);
    const recentTrips = await prisma.trip.findMany({
      take: 5, orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { plateNumber: true, make: true } } }
    });
    return res.json({ total, active, onTrip, inMaintenance, inactive, recentTrips });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// GET /vehicles/stats/depreciation - fleet depreciation overview -- must precede /:id
router.get('/stats/depreciation', async (req: AuthRequest, res: Response) => {
  try {
    const depreciations = await prisma.assetDepreciation.findMany({
      include: {
        vehicle: { select: { id: true, plateNumber: true, make: true, model: true, category: true, status: true, year: true } },
        monthlyEntries: { orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 1 }
      },
      orderBy: { bookValue: 'desc' }
    });

    const fleet = depreciations.map(d => {
      const ageYears = ((Date.now() - new Date(d.startDate).getTime()) / (365.25 * 86400000));
      const remainingYears = Math.max(0, d.usefulLifeYears - ageYears);
      return {
        vehicleId: d.vehicle.id,
        plateNumber: d.vehicle.plateNumber,
        make: d.vehicle.make,
        model: d.vehicle.model,
        category: d.vehicle.category,
        status: d.vehicle.status,
        year: d.vehicle.year,
        purchaseCost: d.purchaseCost,
        residualValue: d.residualValue,
        usefulLifeYears: d.usefulLifeYears,
        method: d.method,
        monthlyDepreciation: d.monthlyDepreciation,
        accumulatedDepr: d.accumulatedDepr,
        bookValue: d.bookValue,
        startDate: d.startDate,
        remainingYears: Math.round(remainingYears * 10) / 10,
        depreciationPct: d.purchaseCost > 0 ? Math.round((d.accumulatedDepr / d.purchaseCost) * 100) : 0,
        lastEntry: d.monthlyEntries[0] || null,
      };
    });

    const summary = {
      totalPurchaseCost: fleet.reduce((s, v) => s + v.purchaseCost, 0),
      totalBookValue: fleet.reduce((s, v) => s + v.bookValue, 0),
      totalAccumulatedDepr: fleet.reduce((s, v) => s + v.accumulatedDepr, 0),
      totalMonthlyDepr: fleet.reduce((s, v) => s + v.monthlyDepreciation, 0),
      vehicleCount: fleet.length,
    };

    return res.json({ fleet, summary });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// POST /vehicles/depreciation/run-all -- must precede /:id
router.post('/depreciation/run-all', async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.body;
    const m = Number(month); const y = Number(year);
    if (!m || !y) return res.status(400).json({ error: 'month and year are required' });

    const depreciations = await prisma.assetDepreciation.findMany({
      include: { vehicle: { select: { plateNumber: true } } }
    });

    const results: any[] = [];
    for (const dep of depreciations) {
      const existing = await prisma.depreciationEntry.findUnique({
        where: { assetId_month_year: { assetId: dep.id, month: m, year: y } }
      });
      if (existing) { results.push({ plate: dep.vehicle.plateNumber, status: 'already_recorded' }); continue; }
      if (dep.bookValue <= dep.residualValue) { results.push({ plate: dep.vehicle.plateNumber, status: 'fully_depreciated' }); continue; }

      const amount = Math.min(dep.monthlyDepreciation, dep.bookValue - dep.residualValue);
      const newBookValue = dep.bookValue - amount;
      const newAccum = dep.accumulatedDepr + amount;

      await prisma.$transaction([
        prisma.depreciationEntry.create({
          data: { assetId: dep.id, month: m, year: y, amount, bookValueAfter: newBookValue, annualDepreciation: dep.monthlyDepreciation * 12 }
        }),
        prisma.assetDepreciation.update({
          where: { id: dep.id }, data: { bookValue: newBookValue, accumulatedDepr: newAccum }
        })
      ]);
      results.push({ plate: dep.vehicle.plateNumber, status: 'recorded', amount, newBookValue });
    }

    return res.json({ results, processed: results.filter(r => r.status === 'recorded').length, total: results.length });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// GET /vehicles
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, category, search } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.status = status;
    if (category) where.category = category;
    if (search) where.OR = [
      { plateNumber: { contains: search } },
      { make: { contains: search } },
      { model: { contains: search } }
    ];
    const vehicles = await prisma.vehicle.findMany({
      where, orderBy: { plateNumber: 'asc' },
      include: {
        assignedDriver: { select: { id: true, firstName: true, lastName: true } },
        depreciation: true
      }
    });
    return res.json({ vehicles });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// GET /vehicles/:id  (UUID only — prevents capturing /pairings, /tyres, etc.)
router.get('/:id([0-9a-f-]{36})', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const vehicle = await prisma.vehicle.findUnique({
      where: { id },
      include: {
        assignedDriver: { select: { id: true, firstName: true, lastName: true } },
        maintenanceSchedules: { orderBy: { nextDueDate: 'asc' } },
        depreciation: true,
        trips: {
          take: 10, orderBy: { createdAt: 'desc' },
          include: { driver: { select: { id: true, firstName: true, lastName: true } } }
        }
      }
    });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    return res.json({ vehicle });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// POST /vehicles
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { plateNumber, make, model, year, category, vehicleType, categoryId, capacityTons, purchaseCost,
      usefulLifeYears, residualValue, depreciationMethod, fuelType, fuelTankCapacity, engineNumber,
      chassisNumber, color, insuranceExpiry, inspectionExpiry, permitExpiry,
      libreExpiry, boloExpiry, roadFundExpiry, roadworthinessExpiry,
      ownership, ownerName, photo, gpsImei } = req.body;
    if (!plateNumber || !make || !model || !category)
      return res.status(400).json({ error: 'plateNumber, make, model, and category are required' });

    const vehicle = await prisma.$transaction(async (tx: any) => {
      const veh = await tx.vehicle.create({
        data: {
          plateNumber, make, model,
          year: year ? Number(year) : new Date().getFullYear(),
          category,
          vehicleType: vehicleType || 'standalone',
          categoryId: categoryId || undefined,
          capacityTons: capacityTons ? Number(capacityTons) : 0,
          purchaseCost: purchaseCost ? Number(purchaseCost) : 0,
          usefulLifeYears: usefulLifeYears ? Number(usefulLifeYears) : 5,
          residualValue: residualValue ? Number(residualValue) : 0,
          depreciationMethod: depreciationMethod || 'straight_line',
          fuelType, fuelTankCapacity: fuelTankCapacity ? Number(fuelTankCapacity) : undefined,
          engineNumber, chassisNumber, color, photo, gpsImei: gpsImei || undefined,
          ownership: ownership || 'company', ownerName: ownerName || undefined,
          insuranceExpiry: insuranceExpiry ? new Date(insuranceExpiry) : undefined,
          inspectionExpiry: inspectionExpiry ? new Date(inspectionExpiry) : undefined,
          permitExpiry: permitExpiry ? new Date(permitExpiry) : undefined,
          libreExpiry: libreExpiry ? new Date(libreExpiry) : undefined,
          boloExpiry: boloExpiry ? new Date(boloExpiry) : undefined,
          roadFundExpiry: roadFundExpiry ? new Date(roadFundExpiry) : undefined,
          roadworthinessExpiry: roadworthinessExpiry ? new Date(roadworthinessExpiry) : undefined,
          status: 'active'
        }
      });

      const cost = Number(purchaseCost) || 0;
      const life = Number(usefulLifeYears) || 5;
      const resid = Number(residualValue) || cost * 0.1;
      const monthly = (cost - resid) / (life * 12);

      if (cost > 0) {
        await tx.assetDepreciation.create({
          data: {
            vehicleId: veh.id,
            purchaseCost: cost,
            usefulLifeYears: life,
            residualValue: resid,
            method: depreciationMethod || 'straight_line',
            monthlyDepreciation: monthly,
            bookValue: cost,
            startDate: new Date()
          }
        });
      }

      // Create default maintenance schedules
      const schedules = [
        { type: 'oil_change', intervalKm: 5000, intervalDays: 90 },
        { type: 'tire_rotation', intervalKm: 10000, intervalDays: 180 },
        { type: 'general_service', intervalKm: 20000, intervalDays: 365 },
        { type: 'inspection', intervalKm: 50000, intervalDays: 365 }
      ];
      for (const s of schedules) {
        await tx.maintenanceSchedule.create({
          data: {
            vehicleId: veh.id,
            maintenanceType: s.type,
            intervalKm: s.intervalKm,
            intervalDays: s.intervalDays,
            nextDueDate: new Date(Date.now() + s.intervalDays * 86400000)
          }
        });
      }
      return veh;
    });

    const created = await prisma.vehicle.findUnique({
      where: { id: vehicle.id },
      include: { maintenanceSchedules: true, depreciation: true }
    });
    return res.status(201).json({ vehicle: created });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// PUT /vehicles/:id
router.put('/:id([0-9a-f-]{36})', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.vehicle.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Vehicle not found' });

    const data: any = {};
    const fields: Record<string, any> = req.body;
    const stringFields = ['plateNumber','make','model','category','vehicleType','categoryId','depreciationMethod','fuelType','engineNumber','chassisNumber','color','status','photo','gpsImei','ownership','ownerName','lockReason'];
    const numFields = ['year','capacityTons','purchaseCost','usefulLifeYears','residualValue','currentKm','fuelTankCapacity'];
    const dateFields = ['insuranceExpiry','inspectionExpiry','permitExpiry','libreExpiry','boloExpiry','roadFundExpiry','roadworthinessExpiry'];

    for (const f of stringFields) { if (fields[f] !== undefined) data[f] = fields[f] || null; }
    for (const f of numFields) { if (fields[f] !== undefined) data[f] = Number(fields[f]); }
    for (const f of dateFields) { if (fields[f] !== undefined) data[f] = fields[f] ? new Date(fields[f]) : null; }
    if (fields.assignedDriverId !== undefined) data.assignedDriverId = fields.assignedDriverId || null;

    // If clearing the primary driver, also end any active DriverAssignment so the history is consistent.
    if (fields.assignedDriverId !== undefined && !fields.assignedDriverId && existing.assignedDriverId) {
      await prisma.driverAssignment.updateMany({
        where: { vehicleId: id, driverId: existing.assignedDriverId, status: 'active' },
        data: { status: 'ended', endDate: new Date() },
      });
    }

    const vehicle = await prisma.vehicle.update({ where: { id }, data });
    return res.json({ vehicle });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// DELETE /vehicles/:id - mark inactive
router.delete('/:id([0-9a-f-]{36})', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const existing = await prisma.vehicle.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Vehicle not found' });
    await prisma.vehicle.update({ where: { id }, data: { status: 'inactive' } });
    return res.json({ message: 'Vehicle deactivated successfully' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// GET /vehicles/:id/trips
router.get('/:id/trips', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { page = '1', limit = '20', from, to } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);
    const where: any = { vehicleId: id };
    if (from || to) {
      where.tripDate = {};
      if (from) where.tripDate.gte = new Date(from);
      if (to) where.tripDate.lte = new Date(to);
    }
    const [trips, total] = await Promise.all([
      prisma.trip.findMany({
        where, skip, take: Number(limit), orderBy: { tripDate: 'desc' },
        include: {
          driver: { select: { id: true, firstName: true, lastName: true } },
          order: { select: { id: true, orderNumber: true, customer: { select: { companyName: true } } } }
        }
      }),
      prisma.trip.count({ where })
    ]);
    return res.json({ trips, total, page: Number(page), limit: Number(limit) });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// GET /vehicles/:id/maintenance
router.get('/:id/maintenance', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const skip = (Number(page) - 1) * Number(limit);
    const [workOrders, schedules, total] = await Promise.all([
      prisma.workOrder.findMany({
        where: { vehicleId: id }, skip, take: Number(limit),
        orderBy: { createdAt: 'desc' },
        include: { garage: { select: { id: true, name: true } } }
      }),
      prisma.maintenanceSchedule.findMany({ where: { vehicleId: id } }),
      prisma.workOrder.count({ where: { vehicleId: id } })
    ]);
    return res.json({ workOrders, schedules, total });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// POST /vehicles/:id/depreciation/run-month - record a month's depreciation
router.post('/:id/depreciation/run-month', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { month, year } = req.body;
    const m = Number(month); const y = Number(year);
    if (!m || !y) return res.status(400).json({ error: 'month and year are required' });

    const vehicle = await prisma.vehicle.findUnique({ where: { id }, include: { depreciation: true } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    if (!vehicle.depreciation) return res.status(400).json({ error: 'No depreciation record for this vehicle' });

    const dep = vehicle.depreciation;
    const existing = await prisma.depreciationEntry.findUnique({
      where: { assetId_month_year: { assetId: dep.id, month: m, year: y } }
    });
    if (existing) return res.status(400).json({ error: `Depreciation already recorded for ${m}/${y}` });

    if (dep.bookValue <= dep.residualValue) {
      return res.status(400).json({ error: 'Vehicle fully depreciated' });
    }

    const amount = Math.min(dep.monthlyDepreciation, dep.bookValue - dep.residualValue);
    const newBookValue = dep.bookValue - amount;
    const newAccum = dep.accumulatedDepr + amount;

    const [entry] = await prisma.$transaction([
      prisma.depreciationEntry.create({
        data: { assetId: dep.id, month: m, year: y, amount, bookValueAfter: newBookValue, annualDepreciation: dep.monthlyDepreciation * 12 }
      }),
      prisma.assetDepreciation.update({
        where: { id: dep.id }, data: { bookValue: newBookValue, accumulatedDepr: newAccum }
      })
    ]);

    return res.json({ entry, newBookValue, newAccumulatedDepr: newAccum });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// GET /vehicles/:id/depreciation/history - depreciation entries for a vehicle
router.get('/:id/depreciation/history', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const vehicle = await prisma.vehicle.findUnique({ where: { id }, include: { depreciation: true } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    if (!vehicle.depreciation) return res.json({ entries: [], depreciation: null });

    const entries = await prisma.depreciationEntry.findMany({
      where: { assetId: vehicle.depreciation.id },
      orderBy: [{ year: 'desc' }, { month: 'desc' }]
    });

    return res.json({ entries, depreciation: vehicle.depreciation });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// POST /vehicles/:id/km-log
router.post('/:id/km-log', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { km, readingDate, notes } = req.body;
    if (!km) return res.status(400).json({ error: 'km reading is required' });
    const vehicle = await prisma.vehicle.findUnique({ where: { id } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    const log = await prisma.kmLog.create({
      data: {
        vehicleId: id, kmReading: Number(km),
        date: readingDate ? new Date(readingDate) : new Date(),
        notes
      }
    });
    if (Number(km) > (vehicle.currentKm || 0)) {
      await prisma.vehicle.update({ where: { id }, data: { currentKm: Number(km) } });
    }
    return res.status(201).json({ log });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// POST /vehicles/:id/compliance-check
router.post('/:id/compliance-check', async (req: AuthRequest, res: Response) => {
  try {
    const v = await prisma.vehicle.findUnique({ where: { id: req.params.id } }) as any;
    if (!v) return res.status(404).json({ error: 'Vehicle not found' });

    const now = new Date();
    const reasons: string[] = [];
    if (v.insuranceExpiry && new Date(v.insuranceExpiry) <= now) reasons.push('Insurance expired');
    if (v.inspectionExpiry && new Date(v.inspectionExpiry) <= now) reasons.push('Inspection expired');
    if (v.permitExpiry && new Date(v.permitExpiry) <= now) reasons.push('Permit expired');

    if (reasons.length > 0) {
      const updated = await prisma.vehicle.update({
        where: { id: v.id },
        data: { complianceLocked: true, lockReason: reasons.join('; '), lockedAt: now, operationalStatus: 'locked' },
      });
      await prisma.auditLog.create({ data: {
        userId: req.user?.id, action: 'compliance_lock', entityType: 'vehicle',
        entityId: v.id, details: JSON.stringify({ reasons, plateNumber: v.plateNumber }),
      }});
      return res.json({ vehicle: updated, locked: true, reasons });
    }

    return res.json({ vehicle: v, locked: false, reasons: [], message: 'Vehicle is compliant' });
  } catch (error: any) {
    return res.status(500).json({ error: 'Internal server error', detail: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// VEHICLE CATEGORIES (dynamic dropdown)
// ════════════════════════════════════════════════════════════════════════════
router.get('/setup/categories', async (req: AuthRequest, res: Response) => {
  try {
    const categories = await prisma.vehicleCategory.findMany({ orderBy: { label: 'asc' } });
    return res.json({ categories });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/setup/categories', async (req: AuthRequest, res: Response) => {
  try {
    const { name, label, description } = req.body;
    if (!name || !label) return res.status(400).json({ error: 'name and label required' });
    const cat = await prisma.vehicleCategory.create({ data: { name, label, description } });
    return res.status(201).json({ category: cat });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/setup/categories/:catId', async (req: AuthRequest, res: Response) => {
  try {
    const { label, description, isActive } = req.body;
    const cat = await prisma.vehicleCategory.update({
      where: { id: req.params.catId },
      data: { ...(label !== undefined && { label }), ...(description !== undefined && { description }), ...(isActive !== undefined && { isActive }) }
    });
    return res.json({ category: cat });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// DRIVER ASSIGNMENT HISTORY
// ════════════════════════════════════════════════════════════════════════════
router.get('/assignments/history', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, driverId } = req.query as Record<string, string>;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (driverId) where.driverId = driverId;
    const assignments = await prisma.driverAssignment.findMany({
      where, orderBy: { effectiveDate: 'desc' },
      include: {
        driver: { select: { id: true, firstName: true, lastName: true } },
        vehicle: { select: { id: true, plateNumber: true, make: true, model: true } }
      }
    });
    return res.json({ assignments });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/assignments', async (req: AuthRequest, res: Response) => {
  try {
    const { driverId, vehicleId, reason } = req.body;
    if (!driverId || !vehicleId) return res.status(400).json({ error: 'driverId and vehicleId required' });

    const driver = await prisma.employee.findUnique({ where: { id: driverId } });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    // End any current assignment for this driver
    const currentAssignment = await prisma.driverAssignment.findFirst({
      where: { driverId, status: 'active' },
      include: { vehicle: { select: { plateNumber: true } } }
    });
    const previousPlate = currentAssignment?.vehicle?.plateNumber || null;

    if (currentAssignment) {
      await prisma.driverAssignment.update({
        where: { id: currentAssignment.id },
        data: { status: 'ended', endDate: new Date() }
      });
      // Unassign old vehicle
      await prisma.vehicle.update({
        where: { id: currentAssignment.vehicleId },
        data: { assignedDriverId: null }
      });
    }

    // Create new assignment
    const assignment = await prisma.driverAssignment.create({
      data: {
        driverId, vehicleId, reason,
        previousPlate,
        assignedBy: req.user?.id,
        status: 'active',
        effectiveDate: new Date()
      }
    });

    // Update vehicle's assigned driver
    await prisma.vehicle.update({
      where: { id: vehicleId },
      data: { assignedDriverId: driverId }
    });

    return res.status(201).json({ assignment });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// VEHICLE PAIRINGS (front/back truck)
// ════════════════════════════════════════════════════════════════════════════
router.get('/pairings', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.status = status;
    const pairings = await prisma.vehiclePairing.findMany({
      where, orderBy: { pairedDate: 'desc' },
      include: {
        frontVehicle: { select: { id: true, plateNumber: true, make: true, model: true, category: true, vehicleType: true } },
        backVehicle: { select: { id: true, plateNumber: true, make: true, model: true, category: true, vehicleType: true } }
      }
    });
    return res.json({ pairings });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/pairings', async (req: AuthRequest, res: Response) => {
  try {
    const { frontVehicleId, backVehicleId, notes } = req.body;
    if (!frontVehicleId || !backVehicleId) return res.status(400).json({ error: 'frontVehicleId and backVehicleId required' });

    // End any existing active pairing for either vehicle
    await prisma.vehiclePairing.updateMany({
      where: { OR: [{ frontVehicleId, status: 'active' }, { backVehicleId, status: 'active' }] },
      data: { status: 'ended', unpairedDate: new Date() }
    });

    const pairing = await prisma.vehiclePairing.create({
      data: { frontVehicleId, backVehicleId, notes, pairedBy: req.user?.id, status: 'active' },
      include: {
        frontVehicle: { select: { plateNumber: true } },
        backVehicle: { select: { plateNumber: true } }
      }
    });
    return res.status(201).json({ pairing });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/pairings/:pairingId/unpair', async (req: AuthRequest, res: Response) => {
  try {
    const pairing = await prisma.vehiclePairing.update({
      where: { id: req.params.pairingId },
      data: { status: 'ended', unpairedDate: new Date() }
    });
    return res.json({ pairing });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// TYRE ASSET MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════
router.get('/tyres', async (req: AuthRequest, res: Response) => {
  try {
    const { status, vehicleId, search } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.status = status;
    if (vehicleId) where.currentVehicleId = vehicleId;
    if (search) where.OR = [{ serialNumber: { contains: search } }, { brand: { contains: search } }];
    const tyres = await prisma.tyreAsset.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { currentVehicle: { select: { plateNumber: true } } }
    });
    return res.json({ tyres });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/tyres', async (req: AuthRequest, res: Response) => {
  try {
    const { serialNumber, brand, size, pattern, purchaseCost, purchaseDate, supplierId } = req.body;
    if (!serialNumber) return res.status(400).json({ error: 'serialNumber required' });
    const tyre = await prisma.tyreAsset.create({
      data: {
        serialNumber, brand, size, pattern,
        purchaseCost: purchaseCost ? Number(purchaseCost) : 0,
        purchaseDate: purchaseDate ? new Date(purchaseDate) : new Date(),
        supplierId, status: 'in_stock', condition: 'new'
      }
    });
    return res.status(201).json({ tyre });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/tyres/:tyreId/fit', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, position, kmAtFitment, performedBy } = req.body;
    if (!vehicleId) return res.status(400).json({ error: 'vehicleId required' });

    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const tyre = await prisma.tyreAsset.findUnique({ where: { id: req.params.tyreId } });
    if (!tyre) return res.status(404).json({ error: 'Tyre not found' });

    const km = kmAtFitment ? Number(kmAtFitment) : vehicle.currentKm;

    await prisma.tyreAsset.update({
      where: { id: tyre.id },
      data: {
        currentVehicleId: vehicleId,
        firstVehicleId: tyre.firstVehicleId || vehicleId,
        position, fitmentDate: new Date(), fitmentKm: km,
        removalDate: null, removalKm: null,
        status: 'fitted', condition: tyre.condition === 'new' ? 'good' : tyre.condition
      }
    });

    await prisma.tyreHistory.create({
      data: {
        tyreAssetId: tyre.id, action: 'fitted',
        vehiclePlate: vehicle.plateNumber, position, kmAtAction: km, performedBy
      }
    });

    return res.json({ message: 'Tyre fitted successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/tyres/:tyreId/remove', async (req: AuthRequest, res: Response) => {
  try {
    const { reason, condition, kmAtRemoval, performedBy } = req.body;
    const tyre = await prisma.tyreAsset.findUnique({
      where: { id: req.params.tyreId },
      include: { currentVehicle: { select: { plateNumber: true, currentKm: true } } }
    });
    if (!tyre) return res.status(404).json({ error: 'Tyre not found' });

    const km = kmAtRemoval ? Number(kmAtRemoval) : (tyre.currentVehicle?.currentKm || 0);
    const kmRun = tyre.fitmentKm ? km - tyre.fitmentKm : 0;

    await prisma.tyreAsset.update({
      where: { id: tyre.id },
      data: {
        currentVehicleId: null, position: null,
        removalDate: new Date(), removalKm: km,
        totalKmRun: tyre.totalKmRun + Math.max(0, kmRun),
        costPerKm: tyre.purchaseCost > 0 && (tyre.totalKmRun + kmRun) > 0 ? tyre.purchaseCost / (tyre.totalKmRun + kmRun) : null,
        status: condition === 'scrap' ? 'scrap' : 'in_stock',
        condition: condition || 'worn'
      }
    });

    await prisma.tyreHistory.create({
      data: {
        tyreAssetId: tyre.id, action: 'removed',
        vehiclePlate: tyre.currentVehicle?.plateNumber, kmAtAction: km,
        reason, performedBy
      }
    });

    return res.json({ message: 'Tyre removed', kmRun });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/tyres/:tyreId/history', async (req: AuthRequest, res: Response) => {
  try {
    const tyre = await prisma.tyreAsset.findUnique({
      where: { id: req.params.tyreId },
      include: { currentVehicle: { select: { plateNumber: true } }, history: { orderBy: { createdAt: 'desc' } } }
    });
    if (!tyre) return res.status(404).json({ error: 'Tyre not found' });
    return res.json({ tyre });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
