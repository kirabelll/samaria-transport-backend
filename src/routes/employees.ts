import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import bcrypt from 'bcryptjs';
const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { role, department, status } = req.query as any;
    const where: any = {};
    if (role) where.role = role;
    if (department) where.department = department;
    if (status) where.status = status;
    const employees = await prisma.employee.findMany({ where, orderBy: { empNumber: 'asc' } });
    return res.json({ employees });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const emp = await prisma.employee.findUnique({ where: { id: req.params.id },
      include: { vehicle: { select: { plateNumber: true } }, user: { select: { email: true, role: true } } } });
    if (!emp) return res.status(404).json({ error: 'Not found' });
    return res.json({ employee: emp });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { empNumber, firstName, lastName, role, department, basicSalary, perDiemRate,
      hireDate, contractType, phone, email, nationalId, address, bankAccount, status, createUser, userPassword } = req.body;
    if (!empNumber || !firstName || !lastName || !role || !department || !phone)
      return res.status(400).json({ error: 'empNumber, firstName, lastName, role, department, phone required' });
    const emp = await prisma.$transaction(async (tx: any) => {
      const e = await tx.employee.create({ data: {
        empNumber, firstName, lastName, role, department,
        basicSalary: Number(basicSalary)||0, perDiemRate: Number(perDiemRate)||0,
        hireDate: hireDate ? new Date(hireDate) : new Date(),
        contractType: contractType||'permanent', phone, email, nationalId, address, bankAccount,
        status: status || 'active' } });
      if (createUser && email && userPassword) {
        const hash = await bcrypt.hash(userPassword, 10);
        await tx.user.create({ data: { email, password: hash, name: firstName + ' ' + lastName,
          role: role === 'management' ? 'owner' : role, employeeId: e.id } });
      }
      return e;
    });
    return res.status(201).json({ employee: emp });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['empNumber','firstName','lastName','role','department','contractType','phone','email','nationalId','address','bankAccount','status'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['basicSalary','perDiemRate']) if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    if (req.body.hireDate) data.hireDate = new Date(req.body.hireDate);
    const emp = await prisma.employee.update({ where: { id: req.params.id }, data });
    return res.json({ employee: emp });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id/trips', async (req: AuthRequest, res: Response) => {
  try {
    const [asDriver, asHelper] = await Promise.all([
      prisma.trip.findMany({ where: { driverId: req.params.id }, orderBy: { tripDate: 'desc' }, take: 20,
        include: { vehicle: { select: { plateNumber: true } }, customer: { select: { companyName: true } } } }),
      prisma.trip.findMany({ where: { helperId: req.params.id }, orderBy: { tripDate: 'desc' }, take: 20,
        include: { vehicle: { select: { plateNumber: true } } } }),
    ]);
    return res.json({ asDriver, asHelper });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id/attendance', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = { employeeId: req.params.id };
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to); }
    const attendance = await prisma.attendance.findMany({ where, orderBy: { date: 'desc' } });
    return res.json({ attendance });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id/payroll', async (req: AuthRequest, res: Response) => {
  try {
    const payrolls = await prisma.payroll.findMany({ where: { employeeId: req.params.id }, orderBy: [{ year: 'desc' }, { month: 'desc' }] });
    return res.json({ payrolls });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Permanently delete employee/driver and clean up all associated records
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const emp = await prisma.employee.findUnique({ where: { id } });
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    // 1. Unlink User & Vehicle
    await prisma.user.updateMany({ where: { employeeId: id }, data: { employeeId: null } });
    await prisma.vehicle.updateMany({ where: { assignedDriverId: id }, data: { assignedDriverId: null } });

    // 2. Unlink helper trips, fuel logs, work orders, breakdown approvals, handover supervisors
    await prisma.trip.updateMany({ where: { helperId: id }, data: { helperId: null } });
    await prisma.fuelLog.updateMany({ where: { driverId: id }, data: { driverId: null } });
    await prisma.workOrder.updateMany({ where: { technicianId: id }, data: { technicianId: null } });
    await prisma.breakdownReport.updateMany({ where: { approvedById: id }, data: { approvedById: null } });
    await prisma.vehicleHandover.updateMany({ where: { supervisorId: id }, data: { supervisorId: null } });

    // 3. Delete breakdown reports filed by employee
    await prisma.breakdownReport.deleteMany({ where: { reportedById: id } });

    // 4. Delete vehicle handovers involving employee
    await prisma.vehicleHandover.deleteMany({ where: { OR: [{ fromDriverId: id }, { toDriverId: id }] } });

    // 5. Delete assignments, ledgers, scores, reward penalties
    await prisma.driverAssignment.deleteMany({ where: { driverId: id } });
    await prisma.driverLedgerEntry.deleteMany({ where: { driverId: id } });
    await prisma.driverScore.deleteMany({ where: { driverId: id } });
    await prisma.driverRewardPenalty.deleteMany({ where: { driverId: id } });

    // 6. Delete attendances, advances, payroll records
    await prisma.attendance.deleteMany({ where: { employeeId: id } });
    await prisma.driverAdvance.deleteMany({ where: { driverId: id } });
    await prisma.payroll.deleteMany({ where: { employeeId: id } });

    // 7. Cascade and delete trips where this employee was the driver
    const trips = await prisma.trip.findMany({ where: { driverId: id }, select: { id: true } });
    const tripIds = trips.map((t: any) => t.id);
    if (tripIds.length > 0) {
      await prisma.tripStatusHistory.deleteMany({ where: { tripId: { in: tripIds } } });
      await prisma.orderPenalty.deleteMany({ where: { tripId: { in: tripIds } } });
      await prisma.vehicleSwapLog.deleteMany({ where: { tripId: { in: tripIds } } });
      await prisma.sparePartRequest.updateMany({ where: { tripId: { in: tripIds } }, data: { tripId: null } });
      await prisma.fuelLog.deleteMany({ where: { tripId: { in: tripIds } } });
      await prisma.driverAdvance.deleteMany({ where: { tripId: { in: tripIds } } });
      await prisma.settlementLine.deleteMany({ where: { tripId: { in: tripIds } } });
      await prisma.trip.deleteMany({ where: { id: { in: tripIds } } });
    }

    // 8. Delete the employee record permanently
    await prisma.employee.delete({ where: { id } });

    // 9. Safe Audit Log
    try {
      let validUserId = req.user?.id;
      if (validUserId) {
        const userExists = await prisma.user.findUnique({ where: { id: validUserId } });
        if (!userExists) validUserId = undefined;
      }
      await prisma.auditLog.create({
        data: {
          userId: validUserId,
          action: 'delete_permanent',
          entityType: 'employee',
          entityId: id,
          details: JSON.stringify({ empNumber: emp.empNumber, name: `${emp.firstName} ${emp.lastName}`, role: emp.role })
        }
      });
    } catch (auditErr) {
      console.warn('AuditLog creation ignored:', auditErr);
    }

    return res.json({ message: `${emp.role === 'driver' ? 'Driver' : 'Employee'} permanently deleted successfully` });
  } catch (e: any) {
    console.error('Delete employee error:', e);
    return res.status(500).json({ error: e.message || 'Failed to permanently delete employee' });
  }
});

export default router;