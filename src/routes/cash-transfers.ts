import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { postJournalEntry } from '../utils/auto-journal';
import { sendNotification } from '../utils/telegram';
const router = Router();
router.use(authenticate);

// List transfers
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, cashierId, page = '1', limit = '30' } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (cashierId) where.OR = [{ fromCashierId: cashierId }, { toCashierId: cashierId }];
    const skip = (Number(page) - 1) * Number(limit);
    const [transfers, total] = await Promise.all([
      prisma.cashTransfer.findMany({
        where, skip, take: Number(limit), orderBy: { createdAt: 'desc' },
        include: {
          fromCashier: { select: { name: true, location: true, code: true } },
          toCashier: { select: { name: true, location: true, code: true } },
        },
      }),
      prisma.cashTransfer.count({ where }),
    ]);
    return res.json({ transfers, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Get single transfer
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const transfer = await prisma.cashTransfer.findUnique({
      where: { id: req.params.id },
      include: {
        fromCashier: { select: { name: true, location: true, code: true, currentBalance: true } },
        toCashier: { select: { name: true, location: true, code: true, currentBalance: true } },
      },
    });
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    return res.json({ transfer });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Create transfer request
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { fromCashierId, toCashierId, amount, reason } = req.body;
    if (!fromCashierId || !toCashierId || !amount || !reason)
      return res.status(400).json({ error: 'fromCashierId, toCashierId, amount, reason required' });
    if (fromCashierId === toCashierId)
      return res.status(400).json({ error: 'Cannot transfer to same cashier' });

    const fromCashier = await prisma.cashier.findUnique({ where: { id: fromCashierId } }) as any;
    if (!fromCashier) return res.status(404).json({ error: 'Source cashier not found' });
    if (fromCashier.currentBalance < Number(amount))
      return res.status(400).json({ error: 'Insufficient balance in source cashier' });

    const toCashier = await prisma.cashier.findUnique({ where: { id: toCashierId } }) as any;
    if (!toCashier) return res.status(404).json({ error: 'Destination cashier not found' });

    // Generate transfer number
    const year = new Date().getFullYear();
    const count = await prisma.cashTransfer.count();
    const transferNumber = `CT-${year}-${String(count + 1).padStart(5, '0')}`;

    const transfer = await prisma.cashTransfer.create({
      data: {
        transferNumber,
        fromCashierId,
        toCashierId,
        amount: Number(amount),
        reason,
        status: 'pending',
        requestedBy: req.user?.id,
      },
    });

    // Telegram: notify cash transfer request
    sendNotification('warning', 'system',
      `💰 Cash Transfer Request: ${transferNumber}`,
      `From: ${fromCashier.name}\nTo: ${toCashier.name}\nAmount: ETB ${Number(amount).toLocaleString()}\nReason: ${reason || 'N/A'}`
    ).catch(() => {});

    return res.status(201).json({ transfer });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Approve transfer
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const transfer = await prisma.cashTransfer.findUnique({ where: { id: req.params.id } }) as any;
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status !== 'pending') return res.status(400).json({ error: 'Transfer is not pending' });

    const updated = await prisma.cashTransfer.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user?.id, approvedAt: new Date() },
    });
    return res.json({ transfer: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Complete transfer (execute the money movement)
router.put('/:id/complete', async (req: AuthRequest, res: Response) => {
  try {
    const transfer = await prisma.cashTransfer.findUnique({ where: { id: req.params.id } }) as any;
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status !== 'approved') return res.status(400).json({ error: 'Transfer must be approved first' });

    const fromCashier = await prisma.cashier.findUnique({ where: { id: transfer.fromCashierId } }) as any;
    if (fromCashier.currentBalance < transfer.amount)
      return res.status(400).json({ error: 'Insufficient balance in source cashier' });

    const today = new Date().toISOString().split('T')[0];

    await prisma.$transaction(async (tx: any) => {
      // Decrement source
      await tx.cashier.update({
        where: { id: transfer.fromCashierId },
        data: { currentBalance: { decrement: transfer.amount } },
      });
      // Increment destination
      await tx.cashier.update({
        where: { id: transfer.toCashierId },
        data: { currentBalance: { increment: transfer.amount } },
      });
      // Record transactions
      await tx.cashTransaction.create({
        data: {
          cashierId: transfer.fromCashierId, type: 'out', category: 'transfer',
          amount: transfer.amount, referenceId: transfer.id, referenceType: 'cash_transfer',
          description: `Transfer out: ${transfer.transferNumber} - ${transfer.reason}`,
        },
      });
      await tx.cashTransaction.create({
        data: {
          cashierId: transfer.toCashierId, type: 'in', category: 'transfer',
          amount: transfer.amount, referenceId: transfer.id, referenceType: 'cash_transfer',
          description: `Transfer in: ${transfer.transferNumber} - ${transfer.reason}`,
        },
      });
      // Update sessions if open
      const fromSession = await tx.cashierSession.findUnique({
        where: { cashierId_sessionDate: { cashierId: transfer.fromCashierId, sessionDate: today } },
      });
      if (fromSession && fromSession.status === 'open') {
        await tx.cashierSession.update({
          where: { id: fromSession.id },
          data: { totalCashOut: { increment: transfer.amount } },
        });
      }
      const toSession = await tx.cashierSession.findUnique({
        where: { cashierId_sessionDate: { cashierId: transfer.toCashierId, sessionDate: today } },
      });
      if (toSession && toSession.status === 'open') {
        await tx.cashierSession.update({
          where: { id: toSession.id },
          data: { totalCashIn: { increment: transfer.amount } },
        });
      }
      // Mark transfer complete
      await tx.cashTransfer.update({
        where: { id: transfer.id },
        data: { status: 'completed', completedAt: new Date() },
      });
    });
    // Auto-post journal: DR Dest Cash, CR Source Cash
    postJournalEntry({
      sourceType: 'cash_transfer', sourceId: transfer.id, amount: transfer.amount,
      description: `Cash transfer ${transfer.transferNumber} - ${transfer.reason}`,
      reference: transfer.transferNumber, createdBy: req.user?.id,
    }).catch(() => {});
    return res.json({ message: 'Transfer completed' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Reject transfer
router.put('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    const transfer = await prisma.cashTransfer.findUnique({ where: { id: req.params.id } }) as any;
    if (!transfer) return res.status(404).json({ error: 'Not found' });
    if (transfer.status !== 'pending' && transfer.status !== 'approved')
      return res.status(400).json({ error: 'Transfer cannot be rejected' });

    const updated = await prisma.cashTransfer.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectedBy: req.user?.id, rejectedReason: reason || null },
    });
    return res.json({ transfer: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delete single cash transfer
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { id } = req.params;
    const transfer = await prisma.cashTransfer.findUnique({ where: { id } });
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });

    await prisma.cashTransfer.delete({ where: { id } });
    return res.json({ message: 'Transfer deleted successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Clear all cash transfers
router.delete('/', async (req: AuthRequest, res: Response) => {
  try {
    const result = await prisma.cashTransfer.deleteMany({});
    return res.json({ message: 'Transfers cleared successfully', count: result.count });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
