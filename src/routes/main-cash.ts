import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// Get main cash center
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    let center = await prisma.mainCashCenter.findFirst();
    if (!center) {
      center = await prisma.mainCashCenter.create({ data: {
        name: 'Main Cash', totalBalance: 0, lastReconciledAt: new Date(),
      }});
    }
    // Get sub-cashiers
    const cashiers = await prisma.cashier.findMany({ where: { isActive: true } });
    const allocations = await prisma.cashAllocation.findMany({
      where: { mainCashId: center.id },
      orderBy: { createdAt: 'desc' }, take: 50,
      include: { cashier: { select: { name: true } } },
    });
    return res.json({ center, cashiers, allocations });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Allocate funds to a sub-cashier
router.post('/allocate', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId, amount, reference, notes } = req.body;
    if (!cashierId || !amount) return res.status(400).json({ error: 'cashierId and amount required' });
    const center = await prisma.mainCashCenter.findFirst();
    if (!center) return res.status(404).json({ error: 'Main cash center not found' });
    if (Number(amount) > (center as any).totalBalance) {
      return res.status(400).json({ error: 'Insufficient balance in main cash' });
    }
    const allocation = await prisma.$transaction(async (tx: any) => {
      const alloc = await tx.cashAllocation.create({ data: {
        mainCashId: center.id, cashierId, type: 'allocation',
        amount: Number(amount), reference, notes, allocatedBy: req.user?.id || '',
      }});
      await tx.mainCashCenter.update({ where: { id: center.id },
        data: { totalBalance: { decrement: Number(amount) } } });
      await tx.cashier.update({ where: { id: cashierId },
        data: { currentBalance: { increment: Number(amount) } } });
      return alloc;
    });
    return res.status(201).json({ allocation });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Return funds from sub-cashier
router.post('/return', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId, amount, reference, notes } = req.body;
    if (!cashierId || !amount) return res.status(400).json({ error: 'cashierId and amount required' });
    const center = await prisma.mainCashCenter.findFirst();
    if (!center) return res.status(404).json({ error: 'Main cash center not found' });
    const allocation = await prisma.$transaction(async (tx: any) => {
      const alloc = await tx.cashAllocation.create({ data: {
        mainCashId: center.id, cashierId, type: 'return',
        amount: Number(amount), reference, notes, allocatedBy: req.user?.id || '',
      }});
      await tx.mainCashCenter.update({ where: { id: center.id },
        data: { totalBalance: { increment: Number(amount) } } });
      await tx.cashier.update({ where: { id: cashierId },
        data: { currentBalance: { decrement: Number(amount) } } });
      return alloc;
    });
    return res.status(201).json({ allocation });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Deposit funds to main cash
router.post('/deposit', async (req: AuthRequest, res: Response) => {
  try {
    const { amount, reference, notes } = req.body;
    if (!amount) return res.status(400).json({ error: 'amount required' });
    const center = await prisma.mainCashCenter.findFirst();
    if (!center) return res.status(404).json({ error: 'Main cash center not found' });
    await prisma.mainCashCenter.update({ where: { id: center.id },
      data: { totalBalance: { increment: Number(amount) } } });
    const allocation = await prisma.cashAllocation.create({ data: {
      mainCashId: center.id, type: 'deposit', amount: Number(amount),
      reference, notes, allocatedBy: req.user?.id || '',
    }});
    return res.status(201).json({ allocation });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Settlement report
router.get('/settlement', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to } = req.query as any;
    const where: any = {};
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const center = await prisma.mainCashCenter.findFirst();
    const cashiers = await prisma.cashier.findMany({ where: { isActive: true },
      select: { id: true, name: true, floatAmount: true, currentBalance: true } });
    const allocations = await prisma.cashAllocation.findMany({ where,
      include: { cashier: { select: { name: true } } }, orderBy: { createdAt: 'desc' } });
    const totalAllocated = allocations.filter((a: any) => a.type === 'allocation').reduce((s: number, a: any) => s + a.amount, 0);
    const totalReturned = allocations.filter((a: any) => a.type === 'return').reduce((s: number, a: any) => s + a.amount, 0);
    const totalDeposited = allocations.filter((a: any) => a.type === 'deposit').reduce((s: number, a: any) => s + a.amount, 0);
    return res.json({
      center, cashiers, allocations,
      summary: { totalAllocated, totalReturned, totalDeposited,
        netFlow: totalDeposited - totalAllocated + totalReturned,
        subCashierTotal: cashiers.reduce((s: number, c: any) => s + (c.currentBalance || 0), 0) },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// B3: Customer collection - all customer payments must go through Main Cash
router.post('/customer-collection', async (req: AuthRequest, res: Response) => {
  try {
    const { amount, customerId, invoiceId, settlementId, paymentMethod, reference, notes } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'amount required' });

    let center = await prisma.mainCashCenter.findFirst() as any;
    if (!center) {
      center = await prisma.mainCashCenter.create({ data: { name: 'Main Cash', totalBalance: 0 } });
    }

    const collectionAmt = Number(amount);

    await prisma.$transaction(async (tx: any) => {
      // Increment Main Cash balance
      await tx.mainCashCenter.update({ where: { id: center.id }, data: { totalBalance: { increment: collectionAmt } } });
      // Record allocation
      await tx.cashAllocation.create({ data: {
        mainCashId: center.id, type: 'deposit', amount: collectionAmt,
        reference: reference || `Customer collection${invoiceId ? ` - INV ${invoiceId}` : ''}`,
        notes: notes || null, allocatedBy: req.user?.id || 'system',
      }});
      // If invoiceId provided, record payment on invoice
      if (invoiceId) {
        await tx.invoicePayment.create({ data: {
          invoiceId, amount: collectionAmt, method: paymentMethod || 'cash',
          reference: reference || null, notes: notes || null, receivedBy: req.user?.id,
        }});
        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } }) as any;
        if (invoice) {
          const newPaid = (invoice.paidAmount || 0) + collectionAmt;
          const newBalance = Math.max(0, invoice.totalAmount - newPaid);
          await tx.invoice.update({ where: { id: invoiceId }, data: {
            paidAmount: newPaid, balanceDue: newBalance,
            status: newBalance <= 0 ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid',
          }});
          // Update customer outstanding balance
          if (invoice.customerId) {
            await tx.customer.update({ where: { id: invoice.customerId }, data: {
              outstandingBalance: { decrement: collectionAmt },
            }});
          }
        }
      }
    });

    const updatedCenter = await prisma.mainCashCenter.findFirst();
    return res.json({ success: true, mainCashBalance: updatedCenter?.totalBalance || 0 });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// B3: Get all balances - Main Cash + sub-cashiers + total
router.get('/balances', async (req: AuthRequest, res: Response) => {
  try {
    let center = await prisma.mainCashCenter.findFirst() as any;
    if (!center) center = { totalBalance: 0 };
    const cashiers = await prisma.cashier.findMany({
      where: { isActive: true }, select: { id: true, name: true, location: true, currentBalance: true },
    });
    const subCashierTotal = cashiers.reduce((s: number, c: any) => s + (c.currentBalance || 0), 0);
    return res.json({
      mainCashBalance: center.totalBalance || 0,
      cashiers,
      subCashierTotal,
      totalCompanyCash: (center.totalBalance || 0) + subCashierTotal,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
