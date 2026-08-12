import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { postJournalEntry } from '../utils/auto-journal';
import { sendNotification } from '../utils/telegram';
const router = Router();
router.use(authenticate);

// ── Helpers ──────────────────────────────────────────────────
async function nextSettlementNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const last = await prisma.settlement.findFirst({ orderBy: { createdAt: 'desc' } });
  const seq = last ? parseInt(last.settlementNumber.split('-').pop() || '0') + 1 : 1;
  return `STL-${year}-${String(seq).padStart(6, '0')}`;
}

async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const last = await prisma.invoice.findFirst({ orderBy: { createdAt: 'desc' } });
  const seq = last ? parseInt(last.invoiceNumber.split('-').pop() || '0') + 1 : 1;
  return `INV-${year}-${String(seq).padStart(6, '0')}`;
}

// ── List settlements ─────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, customerId, orderId } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (customerId) where.customerId = customerId;
    if (orderId) where.orderId = orderId;

    const settlements = await prisma.settlement.findMany({
      where,
      include: {
        order: { include: { customer: true } },
        lines: true,
        invoice: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return res.json({ settlements });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Get single settlement ────────────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const settlement = await prisma.settlement.findUnique({
      where: { id: req.params.id },
      include: {
        order: { include: { customer: true } },
        lines: true,
        invoice: { include: { payments: true } },
      },
    });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    return res.json(settlement);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Generate settlement from order ───────────────────────────
router.post('/generate/:orderId', async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.customerOrder.findUnique({
      where: { id: req.params.orderId },
      include: {
        customer: true,
        trips: {
          where: { status: 'completed' },
          include: { advances: true, fuelLogs: true },
        },
        penalties: { where: { status: { in: ['approved', 'applied'] } } },
      },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.trips.length === 0) return res.status(400).json({ error: 'No completed trips for this order' });

    const rate = order.adjustedRate || order.ratePerTon || 0;
    const totalDelivered = order.trips.reduce((s, t: any) => s + (t.deliveredQuantityTons || 0), 0);
    const grossAmount = totalDelivered * rate;

    // Build settlement lines
    const lines: any[] = [];

    // Delivery lines per trip
    for (const trip of order.trips) {
      const delivered = (trip as any).deliveredQuantityTons || 0;
      lines.push({
        tripId: trip.id,
        type: 'delivery',
        description: `Trip ${trip.tripNumber} delivery`,
        quantity: delivered,
        rate,
        amount: delivered * rate,
      });
    }

    // Penalty lines
    let totalPenalties = 0;
    for (const p of order.penalties) {
      lines.push({
        tripId: p.tripId,
        type: `penalty_${p.type}`,
        description: p.description || `${p.type} penalty`,
        quantity: p.quantityAffected,
        rate: p.rateApplied,
        amount: -Math.abs(p.amount),
      });
      totalPenalties += Math.abs(p.amount);
    }

    // Per diem lines (sum driver per diem across trips)
    let totalPerDiem = 0;
    for (const trip of order.trips) {
      const driver = await prisma.employee.findUnique({ where: { id: trip.driverId } });
      if (driver && driver.perDiemRate > 0) {
        // Calculate trip days (at least 1)
        const tripStart = trip.departureTime || trip.tripDate;
        const tripEnd = (trip as any).unloadingEndTime || trip.updatedAt;
        const days = Math.max(1, Math.ceil((new Date(tripEnd).getTime() - new Date(tripStart).getTime()) / (1000 * 60 * 60 * 24)));
        const perDiem = days * driver.perDiemRate;
        totalPerDiem += perDiem;
        lines.push({
          tripId: trip.id,
          type: 'per_diem',
          description: `Per diem: ${driver.firstName} ${driver.lastName} (${days} days)`,
          quantity: days,
          rate: driver.perDiemRate,
          amount: -perDiem,
        });
      }
    }

    // B7: Calculate shortage and customer deduction totals
    const shortageQuantity = order.trips.reduce((s, t: any) => s + (t.shortage || 0), 0);
    const shortageValue = shortageQuantity * rate;
    const customerDeductionAmount = order.trips.reduce((s, t: any) => s + (t.customerDeductionAmount || 0), 0);

    const netAmount = grossAmount - totalPenalties - totalPerDiem;
    const finalCollectibleAmount = netAmount - customerDeductionAmount;
    const settlementNumber = await nextSettlementNumber();

    const settlement = await prisma.settlement.create({
      data: {
        settlementNumber,
        orderId: order.id,
        customerId: order.customerId,
        totalDeliveredTons: totalDelivered,
        baseRate: order.baseRate || order.ratePerTon || 0,
        adjustedRate: rate,
        grossAmount,
        totalPenalties,
        totalPerDiem,
        netAmount,
        // B7: Collection tracking
        shortageQuantity,
        shortageValue,
        customerDeductionAmount,
        finalCollectibleAmount,
        collectedAmount: 0,
        remainingAmount: finalCollectibleAmount,
        status: 'draft',
        notes: req.body.notes,
        lines: { create: lines },
      },
      include: { lines: true, order: { include: { customer: true } } },
    });

    // Telegram: notify settlement created
    const custName = (settlement as any).order?.customer?.companyName || 'Unknown';
    sendNotification('info', 'order',
      `📋 Settlement Generated: ${(settlement as any).settlementNumber}`,
      `Customer: ${custName}\nGross: ETB ${grossAmount.toLocaleString()}\nPenalties: ETB ${totalPenalties.toLocaleString()}\nNet Amount: ETB ${netAmount.toLocaleString()}`
    ).catch(() => {});

    return res.status(201).json(settlement);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Review settlement ────────────────────────────────────────
router.put('/:id/review', async (req: AuthRequest, res: Response) => {
  try {
    const settlement = await prisma.settlement.findUnique({ where: { id: req.params.id } });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    if (settlement.status !== 'draft') return res.status(400).json({ error: 'Only draft settlements can be reviewed' });

    const updated = await prisma.settlement.update({
      where: { id: req.params.id },
      data: { status: 'reviewed', reviewedBy: req.user!.id, reviewedAt: new Date() },
      include: { order: { include: { customer: true } }, lines: true },
    });
    return res.json(updated);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Approve settlement ───────────────────────────────────────
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const settlement = await prisma.settlement.findUnique({ where: { id: req.params.id } });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    if (!['draft', 'reviewed'].includes(settlement.status)) return res.status(400).json({ error: 'Settlement must be draft or reviewed to approve' });

    const updated = await prisma.settlement.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.user!.id, approvedAt: new Date() },
      include: { order: { include: { customer: true } }, lines: true },
    });
    return res.json(updated);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Generate invoice from approved settlement ────────────────
router.post('/:id/generate-invoice', async (req: AuthRequest, res: Response) => {
  try {
    const settlement = await prisma.settlement.findUnique({
      where: { id: req.params.id },
      include: { order: { include: { customer: true } }, invoice: true },
    });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    if (settlement.status !== 'approved') return res.status(400).json({ error: 'Settlement must be approved to generate invoice' });
    if (settlement.invoice) return res.status(400).json({ error: 'Invoice already generated for this settlement' });

    const invoiceNumber = await nextInvoiceNumber();
    const customer = settlement.order.customer;

    const result = await prisma.$transaction(async (tx) => {
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          customerId: settlement.customerId,
          orderId: settlement.orderId,
          settlementId: settlement.id,
          subtotal: settlement.netAmount,
          totalAmount: settlement.netAmount,
          balanceDue: settlement.netAmount,
          dueDate: customer.creditDays
            ? new Date(Date.now() + customer.creditDays * 86400000)
            : undefined,
          notes: `Generated from settlement ${settlement.settlementNumber}`,
        },
      });

      await tx.settlement.update({
        where: { id: settlement.id },
        data: { status: 'invoiced' },
      });

      // Update order status to invoiced
      await tx.customerOrder.update({
        where: { id: settlement.orderId },
        data: { status: 'invoiced' },
      });

      // Increase customer outstanding balance (reduces available credit)
      await tx.customer.update({
        where: { id: settlement.customerId },
        data: { outstandingBalance: { increment: settlement.netAmount } },
      });

      return invoice;
    });

    // Telegram: notify invoice generated
    sendNotification('info', 'order',
      `🧾 Invoice Generated: ${result.invoiceNumber}`,
      `Settlement: ${settlement.settlementNumber}\nCustomer: ${customer.companyName}\nAmount: ETB ${settlement.netAmount.toLocaleString()}\nDue: ${result.dueDate ? new Date(result.dueDate).toLocaleDateString() : 'On receipt'}`
    ).catch(() => {});

    // Auto-post journal for settlement net amount (adjustments)
    if (settlement.totalPenalties && settlement.totalPenalties > 0) {
      postJournalEntry({
        sourceType: 'shortage_deduction', sourceId: settlement.id, amount: settlement.totalPenalties,
        description: `Settlement ${settlement.settlementNumber} penalties/deductions`,
        reference: settlement.settlementNumber, createdBy: req.user?.id,
      }).catch(() => {});
    }

    return res.status(201).json(result);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Add/update settlement line ───────────────────────────────
router.post('/:id/lines', async (req: AuthRequest, res: Response) => {
  try {
    const settlement = await prisma.settlement.findUnique({ where: { id: req.params.id } });
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
    if (settlement.status === 'invoiced') return res.status(400).json({ error: 'Cannot modify invoiced settlement' });

    const { type, description, quantity, rate, amount, tripId } = req.body;

    const line = await prisma.settlementLine.create({
      data: { settlementId: settlement.id, tripId, type, description, quantity, rate, amount },
    });

    // Recalculate settlement totals
    const allLines = await prisma.settlementLine.findMany({ where: { settlementId: settlement.id } });
    const deliveryTotal = allLines.filter(l => l.type === 'delivery').reduce((s, l) => s + l.amount, 0);
    const penaltyTotal = allLines.filter(l => l.type.startsWith('penalty_')).reduce((s, l) => s + Math.abs(l.amount), 0);
    const perDiemTotal = allLines.filter(l => l.type === 'per_diem').reduce((s, l) => s + Math.abs(l.amount), 0);

    await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        grossAmount: deliveryTotal,
        totalPenalties: penaltyTotal,
        totalPerDiem: perDiemTotal,
        netAmount: deliveryTotal - penaltyTotal - perDiemTotal,
      },
    });

    return res.status(201).json(line);
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ── Delete settlement line ───────────────────────────────────
router.delete('/lines/:lineId', async (req: AuthRequest, res: Response) => {
  try {
    const line = await prisma.settlementLine.findUnique({ where: { id: req.params.lineId } });
    if (!line) return res.status(404).json({ error: 'Line not found' });

    const settlement = await prisma.settlement.findUnique({ where: { id: line.settlementId } });
    if (settlement?.status === 'invoiced') return res.status(400).json({ error: 'Cannot modify invoiced settlement' });

    await prisma.settlementLine.delete({ where: { id: req.params.lineId } });

    // Recalculate
    const allLines = await prisma.settlementLine.findMany({ where: { settlementId: line.settlementId } });
    const deliveryTotal = allLines.filter(l => l.type === 'delivery').reduce((s, l) => s + l.amount, 0);
    const penaltyTotal = allLines.filter(l => l.type.startsWith('penalty_')).reduce((s, l) => s + Math.abs(l.amount), 0);
    const perDiemTotal = allLines.filter(l => l.type === 'per_diem').reduce((s, l) => s + Math.abs(l.amount), 0);

    await prisma.settlement.update({
      where: { id: line.settlementId },
      data: {
        grossAmount: deliveryTotal,
        totalPenalties: penaltyTotal,
        totalPerDiem: perDiemTotal,
        netAmount: deliveryTotal - penaltyTotal - perDiemTotal,
      },
    });

    return res.json({ success: true });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// B7: Record customer collection against settlement
router.put('/:id/record-collection', async (req: AuthRequest, res: Response) => {
  try {
    const { amount, paymentMethod, reference, notes } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: 'amount required and must be positive' });
    const settlement = await prisma.settlement.findUnique({ where: { id: req.params.id } }) as any;
    if (!settlement) return res.status(404).json({ error: 'Settlement not found' });

    const collectionAmt = Number(amount);
    const newCollected = (settlement.collectedAmount || 0) + collectionAmt;
    const remaining = Math.max(0, (settlement.finalCollectibleAmount || settlement.netAmount) - newCollected);

    // Update settlement collection amounts
    await prisma.settlement.update({
      where: { id: req.params.id },
      data: { collectedAmount: newCollected, remainingAmount: remaining },
    });

    // Reduce customer outstanding balance (increases available credit)
    if (settlement.customerId) {
      await prisma.customer.update({
        where: { id: settlement.customerId },
        data: { outstandingBalance: { decrement: collectionAmt } },
      });
    }

    // Record in Main Cash Center
    const mainCash = await prisma.mainCashCenter.findFirst() as any;
    if (mainCash) {
      await prisma.mainCashCenter.update({
        where: { id: mainCash.id },
        data: { totalBalance: { increment: collectionAmt } },
      });
      await prisma.cashAllocation.create({ data: {
        mainCashId: mainCash.id, type: 'deposit', amount: collectionAmt,
        reference: `Collection: ${settlement.settlementNumber}`, notes: notes || null,
        allocatedBy: req.user?.id || 'system',
      }});
    }

    // If there's an invoice, record payment on it
    if (settlement.invoice) {
      // Find invoice for this settlement
      const invoice = await prisma.invoice.findFirst({ where: { settlementId: req.params.id } }) as any;
      if (invoice) {
        await prisma.invoicePayment.create({ data: {
          invoiceId: invoice.id, amount: collectionAmt, method: paymentMethod || 'cash',
          reference: reference || null, notes: notes || null, receivedBy: req.user?.id,
        }});
        const newPaid = (invoice.paidAmount || 0) + collectionAmt;
        const newBalance = Math.max(0, invoice.totalAmount - newPaid);
        await prisma.invoice.update({ where: { id: invoice.id }, data: {
          paidAmount: newPaid, balanceDue: newBalance,
          status: newBalance <= 0 ? 'paid' : newPaid > 0 ? 'partial' : 'unpaid',
        }});
      }
    }

    return res.json({ success: true, collectedAmount: newCollected, remainingAmount: remaining });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
