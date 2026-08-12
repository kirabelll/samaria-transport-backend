import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

router.get('/owners', async (req: AuthRequest, res: Response) => {
  try {
    const owners = await prisma.rentalOwner.findMany({ orderBy: { name: 'asc' },
      include: { _count: { select: { vehicles: true } } } });
    return res.json({ owners });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/owners', async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, phone, email, bankAccount, paymentTerms, address,
      ownerType, role, driverName, driverPhone, driverLicenseNumber,
      bankName, bankAccountHolder, bankAccountNumber, paymentMethod,
    } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'name, phone required' });
    const owner = await prisma.rentalOwner.create({ data: {
      name, phone, email, bankAccount, paymentTerms: paymentTerms||'cash', address,
      ownerType: ownerType || null,
      role: role || null,
      driverName: driverName || null,
      driverPhone: driverPhone || null,
      driverLicenseNumber: driverLicenseNumber || null,
      bankName: bankName || null,
      bankAccountHolder: bankAccountHolder || null,
      bankAccountNumber: bankAccountNumber || null,
      paymentMethod: paymentMethod || null,
    } });
    return res.status(201).json({ owner });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/owners/:id', async (req: AuthRequest, res: Response) => {
  try {
    const {
      name, phone, email, bankAccount, paymentTerms, address,
      ownerType, role, driverName, driverPhone, driverLicenseNumber,
      bankName, bankAccountHolder, bankAccountNumber, paymentMethod,
      currentBalance,
    } = req.body;
    // Only pass through known fields to stay backward-compatible and safe.
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;
    if (email !== undefined) data.email = email;
    if (bankAccount !== undefined) data.bankAccount = bankAccount;
    if (paymentTerms !== undefined) data.paymentTerms = paymentTerms;
    if (address !== undefined) data.address = address;
    if (ownerType !== undefined) data.ownerType = ownerType;
    if (role !== undefined) data.role = role;
    if (driverName !== undefined) data.driverName = driverName;
    if (driverPhone !== undefined) data.driverPhone = driverPhone;
    if (driverLicenseNumber !== undefined) data.driverLicenseNumber = driverLicenseNumber;
    if (bankName !== undefined) data.bankName = bankName;
    if (bankAccountHolder !== undefined) data.bankAccountHolder = bankAccountHolder;
    if (bankAccountNumber !== undefined) data.bankAccountNumber = bankAccountNumber;
    if (paymentMethod !== undefined) data.paymentMethod = paymentMethod;
    if (currentBalance !== undefined) data.currentBalance = Number(currentBalance);
    const owner = await prisma.rentalOwner.update({ where: { id: req.params.id }, data });
    return res.json({ owner });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/owners/:id/vehicles', async (req: AuthRequest, res: Response) => {
  try {
    const vehicles = await prisma.rentalVehicle.findMany({ where: { ownerId: req.params.id } });
    return res.json({ vehicles });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/owners/:id/ledger', async (req: AuthRequest, res: Response) => {
  try {
    const [owner, payments, trips] = await Promise.all([
      prisma.rentalOwner.findUnique({ where: { id: req.params.id } }),
      prisma.rentalPayment.findMany({ where: { ownerId: req.params.id }, orderBy: { paidAt: 'desc' } }),
      prisma.rentalTrip.findMany({ where: { rentalVehicle: { ownerId: req.params.id } }, orderBy: { tripDate: 'desc' }, take: 30 }),
    ]);
    return res.json({ owner, payments, trips });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/owners/vehicles', async (req: AuthRequest, res: Response) => {
  try {
    const { ownerId, plateNumber, vehicleType, capacityTons, ratePerTon, ratePerTrip, paymentTerms } = req.body;
    if (!ownerId || !plateNumber || !vehicleType || !capacityTons) return res.status(400).json({ error: 'ownerId, plateNumber, vehicleType, capacityTons required' });
    const vehicle = await prisma.rentalVehicle.create({ data: { ownerId, plateNumber, vehicleType,
      capacityTons: Number(capacityTons), ratePerTon: ratePerTon ? Number(ratePerTon) : null,
      ratePerTrip: ratePerTrip ? Number(ratePerTrip) : null, paymentTerms: paymentTerms||'cash' } });
    return res.status(201).json({ vehicle });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/vehicles', async (req: AuthRequest, res: Response) => {
  try {
    const vehicles = await prisma.rentalVehicle.findMany({ where: { isActive: true },
      include: { owner: { select: { name: true, phone: true } } }, orderBy: { plateNumber: 'asc' } });
    return res.json({ vehicles });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

/**
 * GET /vehicles/:id/ensure-driver
 * Find-or-create an Employee record mirroring the rental vehicle's driver so it can
 * be used as a trip driverId. Driver info comes from the rental owner record.
 */
router.get('/vehicles/:id/ensure-driver', async (req: AuthRequest, res: Response) => {
  try {
    const rentalId = req.params.id;
    const rv = await (prisma as any).rentalVehicle.findUnique({
      where: { id: rentalId },
      include: { owner: true },
    });
    if (!rv) return res.status(404).json({ error: 'Rental vehicle not found' });

    // Prefer the explicit driver info; if the owner IS the driver, fall back to owner's own name/phone.
    const owner = rv.owner || {};
    const roleVal = owner.role || 'owner_driver';
    const isSelfDrive = roleVal === 'driver' || roleVal === 'owner_driver';
    const driverName = (owner.driverName || (isSelfDrive ? owner.name : '') || '').trim();
    const driverPhone = owner.driverPhone || (isSelfDrive ? owner.phone : '') || '';
    const driverLic = owner.driverLicenseNumber || null;

    if (!driverName) {
      return res.status(400).json({
        error: 'This rental vehicle has no driver information. Open the Rental module and set the driver name on the owner record before assigning a trip.'
      });
    }

    // Try existing mirror
    let emp = await (prisma as any).employee.findUnique({
      where: { sourceRentalVehicleId: rentalId },
    });
    if (emp) {
      // Keep basic fields in sync in case the rental owner record changed
      const parts = driverName.split(' ');
      emp = await prisma.employee.update({
        where: { id: emp.id },
        data: {
          firstName: parts[0] || driverName,
          lastName: parts.slice(1).join(' ') || '-',
          phone: driverPhone || emp.phone,
          nationalId: driverLic || emp.nationalId,
        },
      });
      return res.json({ employee: emp, imported: false });
    }

    // Create new mirror Employee
    const parts = driverName.split(' ');
    const empCount = await prisma.employee.count();
    const empNumber = 'RNT-' + String(empCount + 1).padStart(5, '0');
    emp = await prisma.employee.create({
      data: {
        empNumber,
        firstName: parts[0] || driverName,
        lastName: parts.slice(1).join(' ') || '-',
        role: 'driver',
        department: 'Operations',
        basicSalary: 0,
        perDiemRate: 0,
        hireDate: new Date(),
        contractType: 'contract',
        phone: driverPhone || '-',
        nationalId: driverLic,
        status: 'active',
        sourceRentalVehicleId: rentalId,
      } as any,
    });
    return res.json({ employee: emp, imported: true });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/trips', async (req: AuthRequest, res: Response) => {
  try {
    const { page='1', limit='20' } = req.query as any;
    const skip = (Number(page)-1)*Number(limit);
    const [trips, total] = await Promise.all([
      prisma.rentalTrip.findMany({ skip, take: Number(limit), orderBy: { tripDate: 'desc' },
        include: { rentalVehicle: { include: { owner: { select: { name: true } } } } } }),
      prisma.rentalTrip.count() ]);
    return res.json({ trips, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/trips', async (req: AuthRequest, res: Response) => {
  try {
    const { rentalVehicleId, customerId, pickupLocation, deliveryLocation, quantityTons, ratePerTon, ratePerTrip, customerRevenue, notes } = req.body;
    if (!rentalVehicleId || !pickupLocation || !deliveryLocation || !customerRevenue) return res.status(400).json({ error: 'rentalVehicleId, pickupLocation, deliveryLocation, customerRevenue required' });
    const vehicle = await prisma.rentalVehicle.findUnique({ where: { id: rentalVehicleId } }) as any;
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    const rate = ratePerTon ? Number(ratePerTon) : vehicle.ratePerTon;
    const qty = Number(quantityTons)||0;
    const rentalPayable = ratePerTrip ? Number(ratePerTrip) : (rate && qty ? rate * qty : 0);
    const grossMargin = Number(customerRevenue) - rentalPayable;
    const trip = await prisma.$transaction(async (tx: any) => {
      const t = await tx.rentalTrip.create({ data: {
        rentalVehicleId, customerId: customerId||null, pickupLocation, deliveryLocation,
        quantityTons: qty, ratePerTon: rate||null, ratePerTrip: ratePerTrip ? Number(ratePerTrip) : null,
        customerRevenue: Number(customerRevenue), rentalPayable, grossMargin, notes, status: 'completed' } });
      await tx.rentalOwner.update({ where: { id: vehicle.ownerId }, data: { currentBalance: { decrement: rentalPayable } } });
      return t;
    });
    return res.status(201).json({ trip });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/payments', async (req: AuthRequest, res: Response) => {
  try {
    const { ownerId, amount, type, reference, notes, cashierId } = req.body;
    if (!ownerId || !amount) return res.status(400).json({ error: 'ownerId, amount required' });
    const payment = await prisma.$transaction(async (tx: any) => {
      const p = await tx.rentalPayment.create({ data: { ownerId, amount: Number(amount), type: type||'payment', reference, notes, cashierId: cashierId||null } });
      await tx.rentalOwner.update({ where: { id: ownerId }, data: { currentBalance: { increment: Number(amount) } } });
      if (cashierId) {
        await tx.cashier.update({ where: { id: cashierId }, data: { currentBalance: { decrement: Number(amount) } } });
        await tx.cashTransaction.create({ data: { cashierId, type: 'out', category: 'rental',
          amount: Number(amount), referenceId: p.id, referenceType: 'rental_payment',
          description: 'Rental owner payment' } });
      }
      return p;
    });
    return res.status(201).json({ payment });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/trips/:id/close', async (req: AuthRequest, res: Response) => {
  try {
    const { deliveredQuantityTons, shortage, notes } = req.body;
    const trip = await prisma.rentalTrip.findUnique({ where: { id: req.params.id },
      include: { rentalVehicle: true } }) as any;
    if (!trip) return res.status(404).json({ error: 'Trip not found' });
    const delivered = Number(deliveredQuantityTons) || 0;
    const actualShortage = Math.max(0, (trip.quantityTons || 0) - delivered);
    const rentalPayable = trip.ratePerTrip || (trip.ratePerTon ? trip.ratePerTon * delivered : 0);
    const grossMargin = (trip.customerRevenue || 0) - rentalPayable;
    const updated = await prisma.rentalTrip.update({ where: { id: req.params.id },
      data: { quantityTons: delivered, rentalPayable, grossMargin, status: 'completed', notes: notes || trip.notes } });
    return res.json({ trip: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;