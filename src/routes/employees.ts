import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import bcrypt from 'bcryptjs';
const router = Router();
router.use(authenticate);

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { role, department } = req.query as any;
    const where: any = {};
    if (role) where.role = role;
    if (department) where.department = department;
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
      hireDate, contractType, phone, email, nationalId, address, bankAccount, createUser, userPassword } = req.body;
    if (!empNumber || !firstName || !lastName || !role || !department || !phone)
      return res.status(400).json({ error: 'empNumber, firstName, lastName, role, department, phone required' });
    const emp = await prisma.$transaction(async (tx: any) => {
      const e = await tx.employee.create({ data: {
        empNumber, firstName, lastName, role, department,
        basicSalary: Number(basicSalary)||0, perDiemRate: Number(perDiemRate)||0,
        hireDate: hireDate ? new Date(hireDate) : new Date(),
        contractType: contractType||'permanent', phone, email, nationalId, address, bankAccount } });
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

export default router;