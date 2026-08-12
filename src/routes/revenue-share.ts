import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { sendNotification } from '../utils/telegram';

const router = Router();
router.use(authenticate);

// ════════════════════════════════════════════════════════════════════════════
// CONTRACTS
// ════════════════════════════════════════════════════════════════════════════
router.get('/contracts', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.status = status;
    const contracts = await prisma.revenueShareContract.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: { _count: { select: { trips: true, settlements: true } } }
    });
    return res.json({ contracts });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/contracts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const contract = await prisma.revenueShareContract.findUnique({
      where: { id: req.params.id },
      include: {
        trips: { orderBy: { tripDate: 'desc' }, take: 50, include: { vehicle: { select: { plateNumber: true } } } },
        settlements: { orderBy: { year: 'desc', month: 'desc' } }
      }
    });
    if (!contract) return res.status(404).json({ error: 'Not found' });
    return res.json({ contract });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/contracts', async (req: AuthRequest, res: Response) => {
  try {
    const { powerOwnerId, powerVehiclePlate, companyTrailerPlate, ownerSharePercent,
      companySharePercent, expenseResponsibility, startDate, endDate, notes } = req.body;
    if (!powerVehiclePlate || ownerSharePercent === undefined || companySharePercent === undefined)
      return res.status(400).json({ error: 'powerVehiclePlate, ownerSharePercent, companySharePercent required' });

    const count = await prisma.revenueShareContract.count();
    const contractNumber = 'RSC-' + new Date().getFullYear() + '-' + String(count + 1).padStart(4, '0');

    const contract = await prisma.revenueShareContract.create({
      data: {
        contractNumber, powerOwnerId, powerVehiclePlate, companyTrailerPlate,
        ownerSharePercent: Number(ownerSharePercent),
        companySharePercent: Number(companySharePercent),
        expenseResponsibility: expenseResponsibility ? (typeof expenseResponsibility === 'string' ? expenseResponsibility : JSON.stringify(expenseResponsibility)) : null,
        startDate: new Date(startDate || Date.now()),
        endDate: endDate ? new Date(endDate) : null,
        notes, status: 'active'
      }
    });
    return res.status(201).json({ contract });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/contracts/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['powerOwnerId','powerVehiclePlate','companyTrailerPlate','expenseResponsibility','notes','status'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['ownerSharePercent','companySharePercent'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    if (req.body.startDate) data.startDate = new Date(req.body.startDate);
    if (req.body.endDate) data.endDate = new Date(req.body.endDate);
    const contract = await prisma.revenueShareContract.update({ where: { id: req.params.id }, data });
    return res.json({ contract });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// TRIPS
// ════════════════════════════════════════════════════════════════════════════
router.post('/trips', async (req: AuthRequest, res: Response) => {
  try {
    const { contractId, vehicleId, tripDate, route, customer, quantityTons, tripRevenue,
      fuelCost, driverPerDiem, gpsCost, insuranceCost, brokerCommission, otherExpenses, notes } = req.body;
    if (!contractId || !tripRevenue) return res.status(400).json({ error: 'contractId and tripRevenue required' });

    const contract = await prisma.revenueShareContract.findUnique({ where: { id: contractId } });
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    const totalExp = [fuelCost, driverPerDiem, gpsCost, insuranceCost, brokerCommission, otherExpenses]
      .reduce((s, v) => s + (Number(v) || 0), 0);
    const net = Number(tripRevenue) - totalExp;
    const ownerShare = net * (contract.ownerSharePercent / 100);
    const companyShare = net * (contract.companySharePercent / 100);

    const trip = await prisma.revenueShareTrip.create({
      data: {
        contractId, vehicleId: vehicleId || null,
        tripDate: tripDate ? new Date(tripDate) : new Date(),
        route, customer, quantityTons: quantityTons ? Number(quantityTons) : null,
        tripRevenue: Number(tripRevenue),
        fuelCost: Number(fuelCost) || 0, driverPerDiem: Number(driverPerDiem) || 0,
        gpsCost: Number(gpsCost) || 0, insuranceCost: Number(insuranceCost) || 0,
        brokerCommission: Number(brokerCommission) || 0, otherExpenses: Number(otherExpenses) || 0,
        totalExpenses: totalExp, netIncome: net,
        ownerShare, companyShare, notes
      }
    });
    return res.status(201).json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// MONTHLY SETTLEMENT
// ════════════════════════════════════════════════════════════════════════════
router.post('/settlements/generate', async (req: AuthRequest, res: Response) => {
  try {
    const { contractId, month, year } = req.body;
    if (!contractId || !month || !year) return res.status(400).json({ error: 'contractId, month, year required' });

    const contract = await prisma.revenueShareContract.findUnique({ where: { id: contractId } });
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    const m = Number(month); const y = Number(year);
    const startDate = new Date(y, m - 1, 1);
    const endDate = new Date(y, m, 0, 23, 59, 59);

    const trips = await prisma.revenueShareTrip.findMany({
      where: { contractId, tripDate: { gte: startDate, lte: endDate } }
    });

    const totalRevenue = trips.reduce((s, t) => s + t.tripRevenue, 0);
    const totalExpenses = trips.reduce((s, t) => s + t.totalExpenses, 0);
    const netIncome = totalRevenue - totalExpenses;
    const ownerPayable = netIncome * (contract.ownerSharePercent / 100);
    const companyShare = netIncome * (contract.companySharePercent / 100);

    const count = await prisma.revenueShareSettlement.count();
    const settlementNumber = 'RSS-' + y + '-' + String(m).padStart(2, '0') + '-' + String(count + 1).padStart(4, '0');

    const settlement = await prisma.revenueShareSettlement.upsert({
      where: { contractId_month_year: { contractId, month: m, year: y } },
      create: {
        settlementNumber, contractId, month: m, year: y,
        totalTrips: trips.length, totalRevenue, totalExpenses,
        netIncome, ownerPayable, companyShare, status: 'draft'
      },
      update: {
        totalTrips: trips.length, totalRevenue, totalExpenses,
        netIncome, ownerPayable, companyShare
      }
    });

    return res.json({ settlement, tripCount: trips.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/settlements', async (req: AuthRequest, res: Response) => {
  try {
    const { contractId, status } = req.query as Record<string, string>;
    const where: any = {};
    if (contractId) where.contractId = contractId;
    if (status) where.status = status;
    const settlements = await prisma.revenueShareSettlement.findMany({
      where, orderBy: [{ year: 'desc' }, { month: 'desc' }],
      include: { contract: { select: { contractNumber: true, powerVehiclePlate: true, companyTrailerPlate: true } } }
    });
    return res.json({ settlements });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/settlements/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const settlement = await prisma.revenueShareSettlement.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user?.id, approvedAt: new Date() }
    });
    sendNotification('info', 'system',
      `Revenue Share Settlement Approved: ${settlement.settlementNumber}`,
      `Owner payable: ETB ${settlement.ownerPayable.toLocaleString()}\nCompany share: ETB ${settlement.companyShare.toLocaleString()}`
    ).catch(() => {});
    return res.json({ settlement });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/settlements/:id/pay', async (req: AuthRequest, res: Response) => {
  try {
    const settlement = await prisma.revenueShareSettlement.update({
      where: { id: req.params.id },
      data: { status: 'paid', paidAt: new Date() }
    });
    return res.json({ settlement });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
