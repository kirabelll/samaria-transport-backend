import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

const DEFAULT_CHECKLIST = [
  'Spare Tire', 'Jack', 'Wheel Spanner', 'Fire Extinguisher', 'First Aid Kit',
  'Compressor Hose', 'Hydraulic Accessories', 'Tool Box', 'Documents',
  'Battery', 'Mirrors', 'GPS Device', 'Triangle Warning Sign'
];

// List handovers
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, status } = req.query;
    const where: any = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (status) where.status = status;
    const handovers = await prisma.vehicleHandover.findMany({
      where, orderBy: { createdAt: 'desc' }, take: 100,
      include: {
        vehicle: { select: { plateNumber: true, make: true, model: true } },
        fromDriver: { select: { firstName: true, lastName: true, empNumber: true } },
        toDriver: { select: { firstName: true, lastName: true, empNumber: true } },
        supervisor: { select: { firstName: true, lastName: true } },
        checklistItems: true,
      }
    });
    return res.json({ handovers });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Get single handover
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const handover = await prisma.vehicleHandover.findUnique({
      where: { id: req.params.id },
      include: {
        vehicle: { select: { plateNumber: true, make: true, model: true, currentKm: true } },
        fromDriver: { select: { firstName: true, lastName: true, empNumber: true } },
        toDriver: { select: { firstName: true, lastName: true, empNumber: true } },
        supervisor: { select: { firstName: true, lastName: true } },
        checklistItems: true,
      }
    });
    if (!handover) return res.status(404).json({ error: 'Handover not found' });
    return res.json({ handover });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Create handover
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { vehicleId, fromDriverId, toDriverId, supervisorId, location, kmReading, fuelLevel, notes, checklistItems } = req.body;
    if (!vehicleId || !fromDriverId || !toDriverId) {
      return res.status(400).json({ error: 'vehicleId, fromDriverId, toDriverId are required' });
    }
    const items = checklistItems && checklistItems.length > 0
      ? checklistItems
      : DEFAULT_CHECKLIST.map((name: string) => ({ itemName: name, quantity: 1, status: 'good' }));

    const handover = await prisma.vehicleHandover.create({
      data: {
        vehicleId, fromDriverId, toDriverId, supervisorId: supervisorId || null,
        location, kmReading: kmReading ? Number(kmReading) : null,
        fuelLevel, notes,
        checklistItems: { create: items.map((i: any) => ({
          itemName: i.itemName, partNumber: i.partNumber || null,
          serialNumber: i.serialNumber || null, quantity: i.quantity || 1,
          status: i.status || 'good', remarks: i.remarks || null, photo: i.photo || null,
        })) },
      },
      include: { checklistItems: true, vehicle: { select: { plateNumber: true } },
        fromDriver: { select: { firstName: true, lastName: true } },
        toDriver: { select: { firstName: true, lastName: true } } }
    });

    // Audit log
    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'create', entityType: 'handover',
      entityId: handover.id, details: JSON.stringify({ vehicleId, fromDriverId, toDriverId })
    }});

    return res.status(201).json({ handover });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Accept handover
router.put('/:id/accept', async (req: AuthRequest, res: Response) => {
  try {
    const handover = await prisma.vehicleHandover.update({
      where: { id: req.params.id },
      data: { status: 'accepted' },
    });
    // Transfer vehicle assignment
    await prisma.vehicle.update({
      where: { id: handover.vehicleId },
      data: { assignedDriverId: handover.toDriverId, currentKm: handover.kmReading || undefined },
    });

    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'approve', entityType: 'handover',
      entityId: handover.id, details: 'Handover accepted'
    }});

    return res.json({ handover, message: 'Handover accepted, vehicle reassigned' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Reject handover
router.put('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    const handover = await prisma.vehicleHandover.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectionReason: reason },
    });

    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'reject', entityType: 'handover',
      entityId: handover.id, details: reason || 'Handover rejected'
    }});

    return res.json({ handover });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Update checklist item
router.put('/checklist/:itemId', async (req: AuthRequest, res: Response) => {
  try {
    const { status, remarks, photo } = req.body;
    const item = await prisma.handoverChecklistItem.update({
      where: { id: req.params.itemId },
      data: { status, remarks, photo },
    });
    return res.json({ item });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Get default checklist items
router.get('/defaults/checklist', async (_req: AuthRequest, res: Response) => {
  return res.json({ items: DEFAULT_CHECKLIST });
});

export default router;
