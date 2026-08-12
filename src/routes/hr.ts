import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

router.get('/attendance', async (req: AuthRequest, res: Response) => {
  try {
    const { employeeId, from, to, page='1', limit='50' } = req.query as any;
    const where: any = {};
    if (employeeId) where.employeeId = employeeId;
    if (from || to) { where.date = {}; if (from) where.date.gte = new Date(from); if (to) where.date.lte = new Date(to); }
    const skip = (Number(page)-1)*Number(limit);
    const [attendance, total] = await Promise.all([
      prisma.attendance.findMany({ where, skip, take: Number(limit), orderBy: { date: 'desc' },
        include: { employee: { select: { firstName: true, lastName: true, department: true } } } }),
      prisma.attendance.count({ where }) ]);
    return res.json({ attendance, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/attendance', async (req: AuthRequest, res: Response) => {
  try {
    const { records } = req.body;
    if (!records || !records.length) return res.status(400).json({ error: 'records array required' });
    const created = [];
    for (const r of records) {
      const a = await prisma.attendance.upsert({
        where: { employeeId_date: { employeeId: r.employeeId, date: new Date(r.date) } },
        update: { status: r.status, checkIn: r.checkIn ? new Date(r.checkIn) : null,
          checkOut: r.checkOut ? new Date(r.checkOut) : null, overtimeHours: Number(r.overtimeHours)||0, notes: r.notes||null },
        create: { employeeId: r.employeeId, date: new Date(r.date), status: r.status||'present',
          checkIn: r.checkIn ? new Date(r.checkIn) : null, checkOut: r.checkOut ? new Date(r.checkOut) : null,
          overtimeHours: Number(r.overtimeHours)||0, notes: r.notes||null } });
      created.push(a);
    }
    return res.status(201).json({ created: created.length, attendance: created });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/attendance/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    if (req.body.status) data.status = req.body.status;
    if (req.body.checkIn) data.checkIn = new Date(req.body.checkIn);
    if (req.body.checkOut) data.checkOut = new Date(req.body.checkOut);
    if (req.body.overtimeHours !== undefined) data.overtimeHours = Number(req.body.overtimeHours);
    if (req.body.notes !== undefined) data.notes = req.body.notes;
    const a = await prisma.attendance.update({ where: { id: req.params.id }, data });
    return res.json({ attendance: a });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/payroll', async (req: AuthRequest, res: Response) => {
  try {
    const { month, year, status, employeeId } = req.query as any;
    const where: any = {};
    if (month) where.month = Number(month);
    if (year) where.year = Number(year);
    if (status) where.status = status;
    if (employeeId) where.employeeId = employeeId;
    const payrolls = await prisma.payroll.findMany({ where, orderBy: [{ year: 'desc' }, { month: 'desc' }],
      include: { employee: { select: { empNumber: true, firstName: true, lastName: true, department: true, role: true } } } });
    return res.json({ payrolls });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/payroll/generate', async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.body;
    if (!month || !year) return res.status(400).json({ error: 'month, year required' });
    const m = Number(month), y = Number(year);
    const startDate = new Date(y, m-1, 1);
    const endDate = new Date(y, m, 0, 23, 59, 59);
    const employees = await prisma.employee.findMany({ where: { status: 'active' } });
    const results = [];
    for (const emp of employees) {
      const existing = await prisma.payroll.findUnique({ where: { employeeId_month_year: { employeeId: emp.id, month: m, year: y } } });
      if (existing) { results.push(existing); continue; }
      const [trips, attendance, paidAdvances] = await Promise.all([
        prisma.trip.findMany({ where: { driverId: emp.id, status: 'completed', tripDate: { gte: startDate, lte: endDate } } }),
        prisma.attendance.findMany({ where: { employeeId: emp.id, date: { gte: startDate, lte: endDate } } }),
        prisma.driverAdvance.findMany({ where: { driverId: emp.id, status: 'paid', paidAt: { gte: startDate, lte: endDate } } }),
      ]);
      const perDiem = trips.length * emp.perDiemRate;
      const shortageDeduction = trips.reduce((s: number, t: any) => s + (t.shortageDeduction||0), 0);
      const advanceDeduction = paidAdvances.reduce((s: number, a: any) => s + a.amount, 0);
      const absentDays = attendance.filter((a: any) => a.status === 'absent').length;
      const absenceDeduction = absentDays > 0 ? (emp.basicSalary / 30) * absentDays : 0;
      const overtimeHours = attendance.reduce((s: number, a: any) => s + (a.overtimeHours||0), 0);
      const overtimePay = overtimeHours * (emp.basicSalary / (30 * 8)) * 1.5;
      const totalEarnings = emp.basicSalary + perDiem + overtimePay;
      const totalDeductions = advanceDeduction + shortageDeduction + absenceDeduction;
      const netSalary = totalEarnings - totalDeductions;
      const payroll = await prisma.payroll.create({ data: {
        employeeId: emp.id, month: m, year: y, basicSalary: emp.basicSalary, perDiem,
        incentives: 0, overtimePay, totalEarnings, advanceDeduction, shortageDeduction,
        loanDeduction: 0, absenceDeduction, taxDeduction: 0, otherDeductions: 0,
        totalDeductions, netSalary, status: 'draft' } });
      results.push(payroll);
    }
    return res.json({ generated: results.length, payrolls: results });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/payroll/:id', async (req: AuthRequest, res: Response) => {
  try {
    const p = await prisma.payroll.findUnique({ where: { id: req.params.id },
      include: { employee: true } });
    if (!p) return res.status(404).json({ error: 'Not found' });
    return res.json({ payroll: p });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/payroll/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const p = await prisma.payroll.update({ where: { id: req.params.id },
      data: { status: 'approved', approvedById: req.user?.id, approvedAt: new Date() } });
    return res.json({ payroll: p });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/payroll/:id/pay', async (req: AuthRequest, res: Response) => {
  try {
    const { paymentMethod, cashierId } = req.body;
    const p = await prisma.payroll.update({ where: { id: req.params.id },
      data: { status: 'paid', paidAt: new Date(), paymentMethod: paymentMethod||'bank' } });
    if (cashierId) {
      const pl = await prisma.payroll.findUnique({ where: { id: req.params.id } }) as any;
      await prisma.$transaction(async (tx: any) => {
        await tx.cashier.update({ where: { id: cashierId }, data: { currentBalance: { decrement: pl.netSalary } } });
        await tx.cashTransaction.create({ data: { cashierId, type: 'out', category: 'salary',
          amount: pl.netSalary, referenceId: req.params.id, referenceType: 'payroll',
          description: 'Salary payment' } });
      });
    }
    return res.json({ payroll: p });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Leaves (using attendance notes as a proxy since no Leave model in schema)
// We'll store leaves as a virtual concept using attendance with status 'on_leave'
router.get('/leaves', async (req: AuthRequest, res: Response) => {
  try {
    // Return attendance records with status 'on_leave'
    const { employeeId, status } = req.query as any;
    const where: any = {};
    if (employeeId) where.employeeId = employeeId;
    // Filter by notes containing 'leave_type' marker
    const attendance = await prisma.attendance.findMany({
      where: { ...where, status: 'on_leave' },
      include: { employee: { select: { firstName: true, lastName: true } } },
      orderBy: { date: 'desc' }
    });
    // Map to leave-like structure
    const leaves = attendance.map((a: any) => ({
      id: a.id, employeeId: a.employeeId,
      employee: a.employee, date: a.date, status: 'approved',
      leaveType: a.notes || 'annual', startDate: a.date, endDate: a.date, reason: a.notes
    }));
    return res.json({ leaves });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/leaves', async (req: AuthRequest, res: Response) => {
  try {
    const { employeeId, leaveType, startDate, endDate, reason } = req.body;
    if (!employeeId || !startDate || !endDate) return res.status(400).json({ error: 'employeeId, startDate, endDate required' });
    // Create attendance records for leave period
    const start = new Date(startDate);
    const end = new Date(endDate);
    const created = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = new Date(d);
      if (day.getDay() === 0 || day.getDay() === 6) continue; // Skip weekends
      const a = await prisma.attendance.upsert({
        where: { employeeId_date: { employeeId, date: day } },
        update: { status: 'on_leave', notes: leaveType || 'annual' },
        create: { employeeId, date: day, status: 'on_leave', notes: leaveType || 'annual', overtimeHours: 0 }
      });
      created.push(a);
    }
    return res.status(201).json({ leave: { employeeId, leaveType, startDate, endDate, status: 'approved', days: created.length } });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/leaves/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.body;
    const a = await prisma.attendance.update({ where: { id: req.params.id },
      data: { status: status === 'rejected' ? 'absent' : 'on_leave' } });
    return res.json({ leave: a });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;