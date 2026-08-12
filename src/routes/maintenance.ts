import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { sendNotification } from '../utils/telegram';
import { postJournalEntry } from '../utils/auto-journal';
const router = Router();
router.use(authenticate);

router.get('/garages', async (req: AuthRequest, res: Response) => {
  try {
    const garages = await prisma.garage.findMany({ orderBy: { name: 'asc' } });
    return res.json({ garages });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/garages', async (req: AuthRequest, res: Response) => {
  try {
    const garage = await prisma.garage.create({ data: req.body });
    return res.status(201).json({ garage });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/breakdowns', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    const breakdowns = await prisma.breakdownReport.findMany({ where, orderBy: { reportedAt: 'desc' },
      include: { vehicle: { select: { plateNumber: true } },
        reportedBy: { select: { firstName: true, lastName: true } } } });
    return res.json({ breakdowns });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/breakdowns', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, reportedById, location, description, photos, videoUrl } = req.body;
    if (!vehicleId || !reportedById || !location || !description)
      return res.status(400).json({ error: 'vehicleId, reportedById, location, description required' });
    const report = await prisma.$transaction(async (tx: any) => {
      const r = await tx.breakdownReport.create({ data: { vehicleId, reportedById, location, description, photos, videoUrl, status: 'pending' } });
      await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'breakdown' } });
      return r;
    });
    // Telegram: notify breakdown
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { plateNumber: true } });
    sendNotification('critical', 'breakdown',
      `Vehicle Breakdown: ${vehicle?.plateNumber || vehicleId}`,
      `Location: ${location}\n${description}`
    ).catch(() => {});

    return res.status(201).json({ report });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/breakdowns/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const { approved, rejectionReason } = req.body;
    const report = await prisma.breakdownReport.update({ where: { id: req.params.id }, data: {
      status: approved ? 'approved' : 'rejected',
      approvedById: req.user?.id, approvedAt: new Date(),
      rejectionReason: rejectionReason || null } });
    return res.json({ report });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/work-orders', async (req: AuthRequest, res: Response) => {
  try {
    const { status, vehicleId } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (vehicleId) where.vehicleId = vehicleId;
    const workOrders = await prisma.workOrder.findMany({ where, orderBy: { createdAt: 'desc' },
      include: { vehicle: { select: { plateNumber: true } }, garage: { select: { name: true } },
        technician: { select: { firstName: true, lastName: true } },
        createdBy: { select: { id: true, name: true } } } });
    return res.json({ workOrders });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/work-orders/:id', async (req: AuthRequest, res: Response) => {
  try {
    const wo = await prisma.workOrder.findUnique({ where: { id: req.params.id },
      include: { vehicle: true, garage: true, technician: true, sparePartRequests: true } });
    if (!wo) return res.status(404).json({ error: 'Not found' });
    return res.json({ workOrder: wo });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/work-orders', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, type, breakdownReportId, garageId, garageType, technicianId, description, priority } = req.body;
    if (!vehicleId || !description) return res.status(400).json({ error: 'vehicleId, description required' });
    const count = await prisma.workOrder.count();
    const workOrderNumber = 'WO-' + new Date().getFullYear() + '-' + String(count+1).padStart(5,'0');
    const wo = await prisma.$transaction(async (tx: any) => {
      const w = await tx.workOrder.create({ data: {
        workOrderNumber, vehicleId, type: type||'corrective', description,
        priority: priority||'normal', garageId: garageId||null,
        garageType: garageType||'internal', technicianId: technicianId||null,
        breakdownReportId: breakdownReportId||null, status: 'open',
        createdById: req.user?.id || null } });
      await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'maintenance' } });
      return w;
    });
    // Telegram: notify work order created
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { plateNumber: true } });
    const lvl = priority === 'urgent' ? 'urgent' as const : 'warning' as const;
    sendNotification(lvl, 'maintenance',
      `Work Order ${wo.workOrderNumber}`,
      `${vehicle?.plateNumber || vehicleId} | ${type||'corrective'} | Priority: ${priority||'normal'}\n${description}`
    ).catch(() => {});

    return res.status(201).json({ workOrder: wo });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Earliest editable status for a Work Order. The schema uses 'open' as the initial state
// (see WorkOrder.status default). We treat 'open' as the "draft" phase for edit/delete.
const WO_DRAFT_STATUS = 'open';

router.put('/work-orders/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.workOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const isPrivileged = req.user?.role === 'owner' || req.user?.role === 'admin';
    const isCreator = !!req.user?.id && existing.createdById === req.user.id;
    if (!isPrivileged && !isCreator) {
      return res.status(403).json({ error: 'Only the creator or an owner/admin can edit this work order' });
    }
    if (existing.status !== WO_DRAFT_STATUS) {
      return res.status(400).json({ error: `Work order can only be edited while in '${WO_DRAFT_STATUS}' (draft) status` });
    }

    const data: any = {};
    for (const f of ['status','description','garageId','garageType','technicianId','priority','notes','garageInvoice','type','vehicleId'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['laborCost','partsCost','totalCost','totalDowntimeHours'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    if (req.body.startTime) data.startTime = new Date(req.body.startTime);
    if (req.body.endTime) data.endTime = new Date(req.body.endTime);
    const wo = await prisma.workOrder.update({ where: { id: req.params.id }, data });
    return res.json({ workOrder: wo });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.delete('/work-orders/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.workOrder.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const isPrivileged = req.user?.role === 'owner' || req.user?.role === 'admin';
    const isCreator = !!req.user?.id && existing.createdById === req.user.id;
    if (!isPrivileged && !isCreator) {
      return res.status(403).json({ error: 'Only the creator or an owner/admin can delete this work order' });
    }
    if (existing.status !== WO_DRAFT_STATUS) {
      return res.status(400).json({ error: `Work order can only be deleted while in '${WO_DRAFT_STATUS}' (draft) status` });
    }

    await prisma.$transaction(async (tx: any) => {
      await tx.workOrder.delete({ where: { id: req.params.id } });
      // Revert vehicle status if it was flipped to 'maintenance' for this WO and no other active WO exists
      const otherActive = await tx.workOrder.count({
        where: { vehicleId: existing.vehicleId, status: { in: ['open','in_progress'] } }
      });
      if (otherActive === 0) {
        await tx.vehicle.update({ where: { id: existing.vehicleId }, data: { status: 'active' } });
      }
    });
    return res.json({ success: true });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/work-orders/:id/complete', async (req: AuthRequest, res: Response) => {
  try {
    const { totalCost, laborCost, partsCost, notes } = req.body;
    const existing = await prisma.workOrder.findUnique({ where: { id: req.params.id } }) as any;
    if (!existing) return res.status(404).json({ error: 'Not found' });
    const wo = await prisma.$transaction(async (tx: any) => {
      const updated = await tx.workOrder.update({ where: { id: req.params.id }, data: {
        status: 'completed', endTime: new Date(),
        totalCost: Number(totalCost)||0, laborCost: Number(laborCost)||0, partsCost: Number(partsCost)||0,
        notes: notes||null, approvedById: req.user?.id, approvedAt: new Date() } });
      return updated;
    });
    // Auto-post journal: DR Maintenance Expense, CR Cash
    const woTotal = Number(totalCost) || 0;
    if (woTotal > 0) {
      postJournalEntry({
        sourceType: 'maintenance', sourceId: req.params.id, amount: woTotal,
        description: `Work order ${existing.woNumber} completed - ${existing.description || 'Maintenance'}`,
        reference: existing.woNumber, createdBy: req.user?.id,
      }).catch(() => {});
    }
    return res.json({ workOrder: wo });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/work-orders/:id/handover', async (req: AuthRequest, res: Response) => {
  try {
    const { driverSignature } = req.body;
    const wo = await prisma.$transaction(async (tx: any) => {
      const updated = await tx.workOrder.update({ where: { id: req.params.id }, data: {
        driverSignature: driverSignature||'signed', driverHandoverAt: new Date() } });
      const vehicleId = updated.vehicleId;
      await tx.vehicle.update({ where: { id: vehicleId }, data: { status: 'active' } });
      return updated;
    });
    return res.json({ workOrder: wo });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Garage performance analytics (#13)
router.get('/analytics/garage-performance', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const dateFilter: any = {};
    if (from) dateFilter.gte = new Date(from as string);
    if (to) dateFilter.lte = new Date(to as string);
    const woWhere: any = { status: 'completed' };
    if (from || to) woWhere.endTime = dateFilter;

    const workOrders = await prisma.workOrder.findMany({
      where: woWhere,
      include: {
        garage: { select: { id: true, name: true, isInternal: true, speciality: true, rating: true } },
        vehicle: { select: { plateNumber: true } },
      },
    });

    // Group by garage
    const garageMap: any = {};
    for (const wo of workOrders) {
      const gid = wo.garageId || 'unassigned';
      if (!garageMap[gid]) {
        garageMap[gid] = {
          garageId: gid,
          name: wo.garage?.name || 'Unassigned',
          isInternal: wo.garage?.isInternal ?? true,
          speciality: wo.garage?.speciality || '',
          rating: wo.garage?.rating || 0,
          totalOrders: 0, totalCost: 0, totalLabor: 0, totalParts: 0,
          totalDowntimeHours: 0, durations: [],
        };
      }
      garageMap[gid].totalOrders++;
      garageMap[gid].totalCost += wo.totalCost || 0;
      garageMap[gid].totalLabor += wo.laborCost || 0;
      garageMap[gid].totalParts += wo.partsCost || 0;
      garageMap[gid].totalDowntimeHours += wo.totalDowntimeHours || 0;
      if (wo.startTime && wo.endTime) {
        const hrs = (new Date(wo.endTime).getTime() - new Date(wo.startTime).getTime()) / 3600000;
        garageMap[gid].durations.push(hrs);
      }
    }

    const garages = Object.values(garageMap).map((g: any) => ({
      garageId: g.garageId, name: g.name, isInternal: g.isInternal,
      speciality: g.speciality, rating: g.rating,
      totalOrders: g.totalOrders,
      totalCost: Math.round(g.totalCost),
      avgCost: g.totalOrders > 0 ? Math.round(g.totalCost / g.totalOrders) : 0,
      totalLabor: Math.round(g.totalLabor),
      totalParts: Math.round(g.totalParts),
      avgDowntimeHours: g.totalOrders > 0 ? Number((g.totalDowntimeHours / g.totalOrders).toFixed(1)) : 0,
      avgRepairHours: g.durations.length > 0
        ? Number((g.durations.reduce((a: number, b: number) => a + b, 0) / g.durations.length).toFixed(1)) : 0,
    })).sort((a: any, b: any) => b.totalOrders - a.totalOrders);

    // Vehicle downtime rankings
    const vehicleMap: any = {};
    for (const wo of workOrders) {
      const vid = wo.vehicleId;
      if (!vehicleMap[vid]) vehicleMap[vid] = { vehicleId: vid, plateNumber: wo.vehicle?.plateNumber || '', orders: 0, totalDowntime: 0, totalCost: 0 };
      vehicleMap[vid].orders++;
      vehicleMap[vid].totalDowntime += wo.totalDowntimeHours || 0;
      vehicleMap[vid].totalCost += wo.totalCost || 0;
    }
    const vehicleDowntime = Object.values(vehicleMap).sort((a: any, b: any) => b.totalDowntime - a.totalDowntime).slice(0, 10);

    return res.json({
      garages, vehicleDowntime,
      summary: {
        totalOrders: workOrders.length,
        totalCost: Math.round(workOrders.reduce((s, w) => s + (w.totalCost || 0), 0)),
        avgRepairCost: workOrders.length > 0 ? Math.round(workOrders.reduce((s, w) => s + (w.totalCost || 0), 0) / workOrders.length) : 0,
      },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/schedules', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, status } = req.query as any;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (status) where.status = status;
    // Auto-mark overdue
    await prisma.maintenanceSchedule.updateMany({
      where: { status: 'upcoming', nextDueDate: { lt: new Date() } },
      data: { status: 'overdue' } });
    const schedules = await prisma.maintenanceSchedule.findMany({ where, orderBy: { nextDueDate: 'asc' },
      include: { vehicle: { select: { plateNumber: true, make: true } } } });
    return res.json({ schedules });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/schedules/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['status','notes','maintenanceType'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['intervalKm','intervalDays','lastDoneKm','nextDueKm'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    for (const f of ['lastDoneDate','nextDueDate'])
      if (req.body[f]) data[f] = new Date(req.body[f]);
    const schedule = await prisma.maintenanceSchedule.update({ where: { id: req.params.id }, data });
    return res.json({ schedule });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// MAINTENANCE CLASS TEMPLATES (A/B/C/D)
// ════════════════════════════════════════════════════════════════════════════
router.get('/class-templates', async (req: AuthRequest, res: Response) => {
  try {
    const templates = await prisma.maintenanceClassTemplate.findMany({ orderBy: { className: 'asc' } });
    return res.json({ templates });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/class-templates/seed', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.maintenanceClassTemplate.count();
    if (existing > 0) return res.json({ message: 'Templates already seeded', count: existing });
    const templates = [
      { className: 'A', label: 'Class A - Basic Inspection', defaultIntervalKm: 5000, defaultIntervalDays: 7,
        description: 'Daily/weekly basic inspection and safety checks',
        checklistItems: JSON.stringify(['Brake system inspection','Lights inspection','Tire condition check','Fluid level check/top-up','Belts and hoses check','Battery inspection','Wiper/washer check','Mirrors and glass check','Emergency equipment check','Safety devices check','Wash/cleaning schedule']) },
      { className: 'B', label: 'Class B - Regular Service', defaultIntervalKm: 10000, defaultIntervalDays: 90,
        description: 'Quarterly regular service and fluid analysis',
        checklistItems: JSON.stringify(['Engine oil and filter service','Fuel system inspection','Cooling system inspection','Driveline inspection','Suspension and steering inspection','Detailed brake inspection','Exhaust system inspection','Transmission fluid/condition','Electrical system inspection','Fluid condition analysis']) },
      { className: 'C', label: 'Class C - Major Service', defaultIntervalKm: 40000, defaultIntervalDays: 180,
        description: 'Semi-annual major service and diagnostics',
        checklistItems: JSON.stringify(['Wheel alignment','Wear item replacement','Engine diagnostics','Transmission service','Differential and axle assessment','Hydraulic system inspection','Climate control inspection','Chassis lubrication','Electrical systems analysis']) },
      { className: 'D', label: 'Class D - Major Overhaul', defaultIntervalKm: 80000, defaultIntervalDays: 365,
        description: 'Annual major overhaul and compliance',
        checklistItems: JSON.stringify(['Engine tune-up/diagnostics','Full brake overhaul','Exhaust/emissions compliance','Engine overhaul','Transmission overhaul','Axle/differential overhaul','Suspension overhaul','Electrical system overhaul','Cooling system overhaul','Brake system overhaul','Fuel system overhaul']) },
    ];
    for (const t of templates) {
      await prisma.maintenanceClassTemplate.create({ data: t });
    }
    return res.status(201).json({ message: 'Seeded 4 maintenance class templates' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/class-templates/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['label','description','checklistItems','isActive','className'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['defaultIntervalKm','defaultIntervalDays'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    const template = await prisma.maintenanceClassTemplate.update({ where: { id: req.params.id }, data });
    return res.json({ template });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Apply maintenance class schedule to a vehicle
router.post('/apply-class/:vehicleId', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId } = req.params;
    const { classes } = req.body; // array of class names e.g. ['A','B','C','D']
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });

    const classNames = classes || ['A','B','C','D'];
    const templates = await prisma.maintenanceClassTemplate.findMany({
      where: { className: { in: classNames }, isActive: true }
    });

    const created: any[] = [];
    for (const t of templates) {
      // Check if already exists
      const existing = await prisma.maintenanceSchedule.findFirst({
        where: { vehicleId, maintenanceClass: t.className }
      });
      if (existing) continue;

      const schedule = await prisma.maintenanceSchedule.create({
        data: {
          vehicleId,
          maintenanceType: `class_${t.className.toLowerCase()}`,
          maintenanceClass: t.className,
          intervalKm: t.defaultIntervalKm,
          intervalDays: t.defaultIntervalDays,
          nextDueKm: vehicle.currentKm + (t.defaultIntervalKm || 5000),
          nextDueDate: new Date(Date.now() + (t.defaultIntervalDays || 30) * 86400000),
          alertBeforeKm: (t.defaultIntervalKm || 5000) * 0.1,
          alertBeforeDays: Math.max(3, Math.floor((t.defaultIntervalDays || 30) * 0.1)),
          status: 'upcoming'
        }
      });
      created.push(schedule);
    }

    return res.json({ created, count: created.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Enhanced garage update with performance tracking
router.put('/garages/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['name','address','phone','contactPerson','speciality','status'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    if (req.body.rating !== undefined) data.rating = Number(req.body.rating);
    if (req.body.isInternal !== undefined) data.isInternal = req.body.isInternal;
    const garage = await prisma.garage.update({ where: { id: req.params.id }, data });
    return res.json({ garage });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Update garage performance stats
router.post('/garages/:id/update-stats', async (req: AuthRequest, res: Response) => {
  try {
    const garageId = req.params.id;
    const completedOrders = await prisma.workOrder.findMany({
      where: { garageId, status: 'completed' },
      select: { totalCost: true, startTime: true, endTime: true }
    });
    const totalJobsDone = completedOrders.length;
    const totalSpent = completedOrders.reduce((s, w) => s + (w.totalCost || 0), 0);
    const durations = completedOrders.filter(w => w.startTime && w.endTime).map(w => {
      return (new Date(w.endTime!).getTime() - new Date(w.startTime!).getTime()) / 86400000;
    });
    const avgCompletionDays = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;

    const garage = await prisma.garage.update({
      where: { id: garageId },
      data: { totalJobsDone, totalSpent, avgCompletionDays }
    });
    return res.json({ garage });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;