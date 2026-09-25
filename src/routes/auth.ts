import { Router, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();
const SECRET = process.env.JWT_SECRET || 'secret';

router.post('/login', async (req: any, res: Response) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });
    const user = await prisma.user.findUnique({ where: { email }, include: { employee: true, customer: true } });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid credentials' });
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, SECRET, { expiresIn: '8h' });
    const { password: _p, ...safe } = user as any;
    // Parse permissions JSON if exists
    safe.permissions = safe.permissions ? JSON.parse(safe.permissions) : null;
    return res.json({ token, user: safe });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/setup', async (req: any, res: Response) => {
  try {
    const count = await prisma.user.count();
    if (count > 0) return res.status(403).json({ error: 'Setup already complete' });
    const { email, password, name } = req.body;
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({ data: { email, password: hash, name, role: 'owner' } });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, SECRET, { expiresIn: '8h' });
    const { password: _p, ...safe } = user;
    return res.status(201).json({ token, user: safe });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      include: {
        employee: true,
        customer: true,
        cashierRecord: { select: { id: true, name: true, code: true, location: true, currentBalance: true, isActive: true } }
      }
    });
    if (!user) return res.status(404).json({ error: 'Not found' });
    const { password: _p, ...safe } = user as any;
    safe.permissions = safe.permissions ? JSON.parse(safe.permissions) : null;
    safe.cashierId = safe.cashierRecord?.id || null;
    return res.json({ user: safe });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/users', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { email, password, name, role, employeeId, customerId } = req.body;
    if (!email || !password || !name || !role) return res.status(400).json({ error: 'email,password,name,role required' });
    const exists = await prisma.user.findUnique({ where: { email } });
    if (exists) return res.status(409).json({ error: 'Email exists' });
    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email, password: hash, name, role,
        ...(employeeId && { employeeId }), ...(customerId && { customerId })
      }
    });

    let cashierRecord: any = null;
    if (role === 'cashier') {
      const code = `CSH-${user.id.slice(0, 4).toUpperCase()}`;
      try {
        cashierRecord = await prisma.cashier.create({
          data: {
            userId: user.id,
            name: user.name,
            code,
            floatAmount: 0,
            currentBalance: 0,
            isActive: true,
          }
        });
      } catch (err) {
        console.warn('Could not auto-create cashier record:', err);
      }
    }

    const { password: _p, ...safe } = user as any;
    safe.cashierRecord = cashierRecord;
    safe.cashierId = cashierRecord?.id || null;
    return res.status(201).json({ user: safe });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/change-password', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (currentPassword) {
      const valid = await bcrypt.compare(currentPassword, user.password);
      if (!valid) return res.status(401).json({ error: 'Wrong password' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { password: hash } });
    return res.json({ message: 'Password updated' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/users', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const raw = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        permissions: true,
        createdAt: true,
        employee: { select: { id: true, empNumber: true, firstName: true, lastName: true, role: true } },
        cashierRecord: { select: { id: true, name: true, code: true, location: true, currentBalance: true, isActive: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    const users = raw.map((u: any) => ({
      ...u,
      permissions: u.permissions ? JSON.parse(u.permissions) : null,
      cashierId: u.cashierRecord?.id || null,
      cashierCode: u.cashierRecord?.code || null,
      cashierBalance: u.cashierRecord?.currentBalance ?? null,
    }));
    return res.json({ users });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/users/:id', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { name, role, isActive, newPassword, permissions } = req.body;
    const data: any = {};
    if (name !== undefined) data.name = name;
    if (role !== undefined) data.role = role;
    if (isActive !== undefined) data.isActive = isActive;
    if (newPassword) data.password = await bcrypt.hash(newPassword, 10);
    if (permissions !== undefined) data.permissions = permissions ? JSON.stringify(permissions) : null;
    
    const raw = await prisma.user.update({
      where: { id },
      data,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isActive: true,
        permissions: true,
        createdAt: true,
        employee: { select: { id: true, empNumber: true, firstName: true, lastName: true } },
        cashierRecord: { select: { id: true, name: true, code: true, location: true, currentBalance: true, isActive: true } }
      }
    });

    if (role === 'cashier' && !raw.cashierRecord) {
      try {
        const code = `CSH-${raw.id.slice(0, 4).toUpperCase()}`;
        const newCashier = await prisma.cashier.create({
          data: {
            userId: raw.id,
            name: raw.name,
            code,
            floatAmount: 0,
            currentBalance: 0,
            isActive: true
          }
        });
        (raw as any).cashierRecord = newCashier;
      } catch (err) {
        console.warn('Could not auto-create cashier for existing user:', err);
      }
    }

    const user = {
      ...raw,
      permissions: (raw as any).permissions ? JSON.parse((raw as any).permissions) : null,
      cashierId: raw.cashierRecord?.id || null,
      cashierCode: raw.cashierRecord?.code || null,
      cashierBalance: raw.cashierRecord?.currentBalance ?? null,
    };
    return res.json({ user });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
