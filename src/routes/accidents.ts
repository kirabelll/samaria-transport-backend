import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { sendNotification } from '../utils/telegram';

const router = Router();
router.use(authenticate);

// GET /accidents
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, vehicleId, from, to } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.repairStatus = status;
    if (vehicleId) where.vehicleId = vehicleId;
    if (from || to) { where.accidentDate = {}; if (from) where.accidentDate.gte = new Date(from); if (to) where.accidentDate.lte = new Date(to); }
    const records = await prisma.accidentRecord.findMany({
      where, orderBy: { accidentDate: 'desc' },
      include: { vehicle: { select: { plateNumber: true, make: true } } }
    });
    return res.json({ records });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /accidents/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const record = await prisma.accidentRecord.findUnique({
      where: { id: req.params.id },
      include: { vehicle: { select: { plateNumber: true, make: true, model: true } } }
    });
    if (!record) return res.status(404).json({ error: 'Not found' });
    return res.json({ record });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// POST /accidents
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { accidentDate, location, vehicleId, trailerId, driverId, description,
      photos, policeRefNumber, thirdPartyName, thirdPartyPhone, thirdPartyVehicle,
      thirdPartyInsurer, damageEstimate, responsibility, notes } = req.body;
    if (!accidentDate || !location || !vehicleId || !description)
      return res.status(400).json({ error: 'accidentDate, location, vehicleId, description required' });

    const count = await prisma.accidentRecord.count();
    const accidentNumber = 'ACC-' + new Date().getFullYear() + '-' + String(count + 1).padStart(5, '0');

    const record = await prisma.accidentRecord.create({
      data: {
        accidentNumber, accidentDate: new Date(accidentDate), location, vehicleId,
        trailerId, driverId, description,
        photos: photos ? (typeof photos === 'string' ? photos : JSON.stringify(photos)) : null,
        policeRefNumber, thirdPartyName, thirdPartyPhone, thirdPartyVehicle, thirdPartyInsurer,
        damageEstimate: damageEstimate ? Number(damageEstimate) : null,
        responsibility, notes, repairStatus: 'pending'
      }
    });

    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { plateNumber: true } });
    sendNotification('critical', 'compliance',
      `Accident Report: ${vehicle?.plateNumber || vehicleId}`,
      `Date: ${accidentDate}\nLocation: ${location}\n${description}\nDamage Est: ${damageEstimate ? 'ETB ' + Number(damageEstimate).toLocaleString() : 'N/A'}`
    ).catch(() => {});

    return res.status(201).json({ record });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /accidents/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    const strFields = ['location','description','photos','policeRefNumber','thirdPartyName','thirdPartyPhone',
      'thirdPartyVehicle','thirdPartyInsurer','insuranceClaimRef','insuranceClaimStatus',
      'repairStatus','responsibility','workOrderId','notes','trailerId','driverId'];
    const numFields = ['damageEstimate','actualRepairCost','insuranceClaimAmount','insurancePaidAmount'];
    for (const f of strFields) if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of numFields) if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    if (req.body.accidentDate) data.accidentDate = new Date(req.body.accidentDate);

    const record = await prisma.accidentRecord.update({ where: { id: req.params.id }, data });
    return res.json({ record });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /accidents/summary/stats
router.get('/summary/stats', async (req: AuthRequest, res: Response) => {
  try {
    const records = await prisma.accidentRecord.findMany({
      include: { vehicle: { select: { plateNumber: true } } }
    });
    const totalDamage = records.reduce((s, r) => s + (r.damageEstimate || 0), 0);
    const totalRepairCost = records.reduce((s, r) => s + (r.actualRepairCost || 0), 0);
    const totalInsurancePaid = records.reduce((s, r) => s + (r.insurancePaidAmount || 0), 0);
    const pendingClaims = records.filter(r => r.insuranceClaimStatus === 'pending' || r.insuranceClaimStatus === 'submitted').length;

    return res.json({
      total: records.length,
      pendingRepair: records.filter(r => r.repairStatus === 'pending').length,
      inProgress: records.filter(r => r.repairStatus === 'in_progress').length,
      completed: records.filter(r => r.repairStatus === 'completed').length,
      pendingClaims,
      totalDamage, totalRepairCost, totalInsurancePaid
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
