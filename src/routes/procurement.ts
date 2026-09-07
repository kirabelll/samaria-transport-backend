import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { generatePurchaseRequestNumber, generatePurchaseOrderNumber, generateGrnNumber, generatePaymentRequestNumber } from '../utils/sequence-generator';
const router = Router();
router.use(authenticate);

router.get('/suppliers', async (req: AuthRequest, res: Response) => {
  try {
    const suppliers = await prisma.supplier.findMany({ orderBy: { name: 'asc' } });
    return res.json({ suppliers });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/suppliers', async (req: AuthRequest, res: Response) => {
  try {
    const { name, contactName, phone, email, address, taxNumber, suppliedCategory, rating, creditLimit, creditTermsDays, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const supplier = await prisma.supplier.create({
      data: { name, contactName, phone, email, address, taxNumber,
        suppliedCategory, rating: rating ? Number(rating) : null,
        creditLimit: creditLimit ? Number(creditLimit) : null,
        creditTermsDays: creditTermsDays ? Number(creditTermsDays) : null,
        notes, status: 'active' }
    });
    return res.status(201).json({ supplier });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /suppliers/:id
router.put('/suppliers/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['name','contactName','phone','email','address','taxNumber','suppliedCategory','notes','status'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['rating','creditLimit','currentBalance'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    if (req.body.creditTermsDays !== undefined) data.creditTermsDays = Number(req.body.creditTermsDays);
    const supplier = await prisma.supplier.update({ where: { id: req.params.id }, data });
    return res.json({ supplier });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /suppliers/:id - supplier detail with purchase history
router.get('/suppliers/:id', async (req: AuthRequest, res: Response) => {
  try {
    const supplier = await prisma.supplier.findUnique({
      where: { id: req.params.id },
      include: {
        purchaseOrders: { orderBy: { createdAt: 'desc' }, take: 20, include: { purchaseRequest: { select: { requestNumber: true } } } },
        quotations: { orderBy: { createdAt: 'desc' }, take: 20 }
      }
    });
    if (!supplier) return res.status(404).json({ error: 'Not found' });
    return res.json({ supplier });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /quotation-comparison/:prId - compare 3+ suppliers
router.get('/quotation-comparison/:prId', async (req: AuthRequest, res: Response) => {
  try {
    const pr = await prisma.purchaseRequest.findUnique({
      where: { id: req.params.prId },
      include: { lines: true }
    });
    if (!pr) return res.status(404).json({ error: 'PR not found' });

    const quotations = await prisma.quotation.findMany({
      where: { purchaseRequestId: req.params.prId },
      include: { supplier: { select: { name: true, rating: true } } },
      orderBy: { unitPrice: 'asc' }
    });

    const comparison = quotations.map((q: any) => ({
      quotationId: q.id,
      supplier: q.supplier?.name || 'Unknown',
      supplierRating: q.supplier?.rating || null,
      quotationNumber: q.quotationNumber,
      unitPrice: q.unitPrice,
      totalPrice: q.totalPrice,
      deliveryDays: q.deliveryDays,
      paymentTerms: q.paymentTerms,
      status: q.status,
      isLowest: false
    }));

    if (comparison.length > 0) comparison[0].isLowest = true;

    return res.json({
      purchaseRequest: pr,
      comparison,
      supplierCount: comparison.length,
      meetsMinimum: comparison.length >= 3,
      lowestSupplier: comparison[0]?.supplier || null,
      lowestPrice: comparison[0]?.unitPrice || null
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/purchase-requests', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    const prs = await prisma.purchaseRequest.findMany({ where, orderBy: { createdAt: 'desc' },
      include: { lines: true, _count: { select: { quotations: true } } } });
    return res.json({ purchaseRequests: prs });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/purchase-requests', async (req: AuthRequest, res: Response) => {
  try {
    const { urgency, notes, lines, department, category, requiredDate, isEmergency, emergencyReason, attachment } = req.body;
    if (!lines || !lines.length) return res.status(400).json({ error: 'At least one line item required' });
    const requestNumber = await generatePurchaseRequestNumber();
    const pr = await prisma.purchaseRequest.create({ data: {
      requestNumber, urgency: urgency||'normal', notes, requestedById: req.user?.id, status: 'pending',
      department, category, attachment,
      requiredDate: requiredDate ? new Date(requiredDate) : null,
      isEmergency: isEmergency || false, emergencyReason,
      lines: { create: lines.map((l: any) => ({
        itemName: l.itemName, partNumber: l.partNumber||null,
        inventoryId: l.inventoryId||null, quantityNeeded: Number(l.quantityNeeded),
        estimatedCost: l.estimatedCost ? Number(l.estimatedCost) : null, notes: l.notes })) } },
      include: { lines: true } });
    return res.status(201).json({ purchaseRequest: pr });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/purchase-requests/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const pr = await prisma.purchaseRequest.update({ where: { id: req.params.id },
      data: { status: 'approved', approvedById: req.user?.id, approvedAt: new Date() } });
    return res.json({ purchaseRequest: pr });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/purchase-requests/:id/quotations', async (req: AuthRequest, res: Response) => {
  try {
    const quotations = await prisma.quotation.findMany({ where: { purchaseRequestId: req.params.id },
      include: { supplier: { select: { name: true } } }, orderBy: { unitPrice: 'asc' } });
    return res.json({ quotations });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/purchase-requests/:id/quotations', async (req: AuthRequest, res: Response) => {
  try {
    const { supplierId, quotationNumber, unitPrice, totalPrice, deliveryDays, paymentTerms, notes } = req.body;
    if (!supplierId || !unitPrice) return res.status(400).json({ error: 'supplierId, unitPrice required' });
    const q = await prisma.quotation.create({ data: {
      purchaseRequestId: req.params.id, supplierId, quotationNumber, paymentTerms,
      unitPrice: Number(unitPrice), totalPrice: Number(totalPrice)||Number(unitPrice),
      deliveryDays: deliveryDays ? Number(deliveryDays) : null, notes, status: 'pending' } });
    return res.status(201).json({ quotation: q });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/quotations/:id/select', async (req: AuthRequest, res: Response) => {
  try {
    const q = await prisma.quotation.findUnique({ where: { id: req.params.id } }) as any;
    if (!q) return res.status(404).json({ error: 'Not found' });
    const pr = await prisma.purchaseRequest.findUnique({ where: { id: q.purchaseRequestId }, include: { lines: true, quotations: true } }) as any;
    if (!pr) return res.status(404).json({ error: 'PR not found' });

    // B2: Enforce minimum 3 quotations for non-emergency purchases
    const quotationCount = pr.quotations?.length || 0;
    if (quotationCount < 3 && !pr.isEmergency) {
      return res.status(400).json({ error: `At least 3 supplier quotations required for non-emergency purchases. Currently have ${quotationCount} quotation(s). Add more quotations or mark the PR as emergency with justification.` });
    }
    if (pr.isEmergency && (!pr.emergencyReason || pr.emergencyReason.trim() === '')) {
      return res.status(400).json({ error: 'Emergency purchases must have a justification reason.' });
    }

    const totalQty = pr.lines.reduce((s: number, l: any) => s + l.quantityNeeded, 0);
    await prisma.$transaction(async (tx: any) => {
      await tx.quotation.updateMany({ where: { purchaseRequestId: q.purchaseRequestId }, data: { status: 'rejected' } });
      await tx.quotation.update({ where: { id: req.params.id }, data: { status: 'selected' } });
      const poNumber = await generatePurchaseOrderNumber(tx);
      await tx.purchaseOrder.create({ data: { poNumber, purchaseRequestId: q.purchaseRequestId,
        supplierId: q.supplierId, quantity: totalQty, unitPrice: q.unitPrice,
        totalAmount: q.totalPrice, status: 'pending',
        promisedLeadDays: q.deliveryDays || null,
        expectedDelivery: q.deliveryDays ? new Date(Date.now() + q.deliveryDays * 86400000) : null,
      } });
      await tx.purchaseRequest.update({ where: { id: q.purchaseRequestId }, data: { status: 'ordered' } });
    });
    return res.json({ message: 'Quotation selected and PO created' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/purchase-orders', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    const pos = await prisma.purchaseOrder.findMany({ where, orderBy: { createdAt: 'desc' },
      include: { supplier: { select: { name: true } }, purchaseRequest: { select: { requestNumber: true } } } });
    return res.json({ purchaseOrders: pos });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /purchase-orders/:id/ship — Mark as Shipped (supplier confirmed dispatch)
router.put('/purchase-orders/:id/ship', async (req: AuthRequest, res: Response) => {
  try {
    const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } }) as any;
    if (!po) return res.status(404).json({ error: 'Not found' });
    if (po.status === 'received' || po.status === 'cancelled') {
      return res.status(400).json({ error: `Cannot mark as shipped: PO is ${po.status}` });
    }
    const updated = await prisma.purchaseOrder.update({ where: { id: req.params.id },
      data: { status: 'shipped', shippedAt: new Date(), shippedById: req.user?.id } });
    return res.json({ purchaseOrder: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Helper: create a GRN against a PO. Updates inventory, supplier KPIs, and PO status.
async function createGRN(req: AuthRequest, poId: string, data: {
  quantityReceived: number;
  quantityDamaged?: number;
  quantityRejected?: number;
  inspectionResult?: string;
  defectsNotes?: string;
  supplierInvoiceNumber?: string;
  attachmentUrl?: string;
  notes?: string;
}) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    include: { purchaseRequest: { include: { lines: true } }, supplier: true, goodsReceipts: true },
  }) as any;
  if (!po) throw Object.assign(new Error('PO not found'), { status: 404 });

  const qtyThis = Number(data.quantityReceived) || 0;
  if (qtyThis <= 0) throw Object.assign(new Error('quantityReceived must be > 0'), { status: 400 });

  const prevReceived = (po.goodsReceipts || []).reduce((s: number, g: any) => s + g.quantityReceived, 0);
  const totalAfter = prevReceived + qtyThis;
  if (totalAfter > po.quantity * 1.05) { // allow 5% over-receipt tolerance
    throw Object.assign(new Error(`Total received (${totalAfter}) exceeds PO quantity (${po.quantity}) by more than 5%.`), { status: 400 });
  }

  // GRN number
  const grnNumber = await generateGrnNumber();

  return await prisma.$transaction(async (tx: any) => {
    // 1) Create GRN
    const grn = await tx.goodsReceiptNote.create({
      data: {
        grnNumber,
        purchaseOrderId: poId,
        receivedById: req.user?.id || '',
        quantityReceived: qtyThis,
        quantityDamaged: Number(data.quantityDamaged) || 0,
        quantityRejected: Number(data.quantityRejected) || 0,
        inspectionResult: data.inspectionResult || 'passed',
        defectsNotes: data.defectsNotes || null,
        supplierInvoiceNumber: data.supplierInvoiceNumber || null,
        attachmentUrl: data.attachmentUrl || null,
        notes: data.notes || null,
      },
    });

    // 2) Update PO: aggregate received qty + damaged + status
    const newDamaged = (po.damagedQuantity || 0) + (Number(data.quantityDamaged) || 0);
    const newStatus = totalAfter >= po.quantity ? 'received' : 'partial';
    await tx.purchaseOrder.update({
      where: { id: poId },
      data: {
        receivedQuantity: totalAfter,
        damagedQuantity: newDamaged,
        receivedAt: new Date(),
        receivedBy: req.user?.id || null,
        status: newStatus,
        invoiceNumber: data.supplierInvoiceNumber || po.invoiceNumber,
      },
    });

    // 3) Mark PR received only on full fulfillment
    if (newStatus === 'received') {
      await tx.purchaseRequest.update({ where: { id: po.purchaseRequestId }, data: { status: 'received' } });
    }

    // 4) Update inventory + transaction lines (proportional to this GRN's share of total)
    const usableQty = qtyThis - (Number(data.quantityRejected) || 0); // rejected goods don't enter stock
    if (usableQty > 0 && po.purchaseRequest?.lines) {
      const ratio = usableQty / po.quantity;
      for (const line of po.purchaseRequest.lines) {
        if (!line.inventoryId) continue;
        const addQty = line.quantityNeeded * ratio;
        const inv = await tx.inventory.findUnique({ where: { id: line.inventoryId } }) as any;
        if (!inv) continue;
        const newStock = inv.quantityInStock + addQty;
        await tx.inventory.update({
          where: { id: line.inventoryId },
          data: {
            quantityInStock: { increment: addQty },
            totalValue: newStock * po.unitPrice,
            lastPurchaseDate: new Date(),
            lastPurchasePrice: po.unitPrice,
            lastReceiptNumber: grnNumber,
          },
        });
        await tx.inventoryTransaction.create({
          data: {
            inventoryId: line.inventoryId, type: 'in',
            quantity: addQty, unitCost: po.unitPrice,
            totalCost: addQty * po.unitPrice,
            purchaseOrderId: po.id,
            receiptNumber: grnNumber,
            supplierId: po.supplierId,
            supplierName: po.supplier?.name || null,
          },
        });
      }
    }

    // 5) Recompute supplier KPIs (avg lead time, quality pass rate, total spend)
    const allGRNs = await tx.goodsReceiptNote.findMany({
      where: { purchaseOrder: { supplierId: po.supplierId } },
      include: { purchaseOrder: { include: { purchaseRequest: true } } },
    });
    if (allGRNs.length > 0) {
      const leadTimes: number[] = [];
      let passed = 0;
      for (const g of allGRNs) {
        const prDate = g.purchaseOrder?.purchaseRequest?.createdAt;
        if (prDate) {
          const days = (g.receivedDate.getTime() - new Date(prDate).getTime()) / 86400000;
          if (days >= 0) leadTimes.push(days);
        }
        if (g.inspectionResult === 'passed') passed++;
      }
      const avgLT = leadTimes.length ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : null;
      const qpr = (passed / allGRNs.length) * 100;
      // simple rating: 1-5 based on quality + lead time
      const expectedLT = po.promisedLeadDays || 30;
      const ltScore = avgLT === null ? 3 : Math.max(1, Math.min(5, 5 - Math.max(0, (avgLT - expectedLT) / 5)));
      const qScore = qpr / 20; // 100% → 5, 0% → 0
      const rating = Math.round((ltScore + qScore) / 2 * 10) / 10;
      const totalSpendAgg = await tx.purchaseOrder.aggregate({
        where: { supplierId: po.supplierId, status: { in: ['received','partial'] } },
        _sum: { totalAmount: true },
      });
      await tx.supplier.update({
        where: { id: po.supplierId },
        data: {
          avgLeadTimeDays: avgLT,
          qualityPassRate: qpr,
          rating,
          totalSpend: totalSpendAgg._sum.totalAmount || 0,
        },
      });
    }

    return grn;
  });
}

// POST /purchase-orders/:id/grn — Create a GRN (preferred entry point)
router.post('/purchase-orders/:id/grn', async (req: AuthRequest, res: Response) => {
  try {
    const grn = await createGRN(req, req.params.id, req.body);
    return res.status(201).json({ goodsReceiptNote: grn, message: 'GRN created' });
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// GET /purchase-orders/:id/grn — List GRNs for a PO
router.get('/purchase-orders/:id/grn', async (req: AuthRequest, res: Response) => {
  try {
    const grns = await prisma.goodsReceiptNote.findMany({
      where: { purchaseOrderId: req.params.id },
      orderBy: { receivedDate: 'desc' },
    });
    return res.json({ goodsReceiptNotes: grns });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /grn — List all GRNs (with filters)
router.get('/grn', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, inspectionResult, supplierId, page = '1', limit = '50' } = req.query as any;
    const where: any = {};
    if (from || to) {
      where.receivedDate = {};
      if (from) where.receivedDate.gte = new Date(from);
      if (to) where.receivedDate.lte = new Date(to);
    }
    if (inspectionResult) where.inspectionResult = inspectionResult;
    if (supplierId) where.purchaseOrder = { supplierId };
    const skip = (Number(page) - 1) * Number(limit);
    const [grns, total] = await Promise.all([
      prisma.goodsReceiptNote.findMany({
        where, skip, take: Number(limit), orderBy: { receivedDate: 'desc' },
        include: { purchaseOrder: { include: { supplier: { select: { name: true } } } } },
      }),
      prisma.goodsReceiptNote.count({ where }),
    ]);
    return res.json({ goodsReceiptNotes: grns, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /grn/:id — Single GRN
router.get('/grn/:id', async (req: AuthRequest, res: Response) => {
  try {
    const grn = await prisma.goodsReceiptNote.findUnique({
      where: { id: req.params.id },
      include: { purchaseOrder: { include: { supplier: true, purchaseRequest: { include: { lines: true } } } } },
    });
    if (!grn) return res.status(404).json({ error: 'Not found' });
    return res.json({ goodsReceiptNote: grn });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /purchase-orders/:id/receive — Backward-compatible: creates a GRN under the hood
router.put('/purchase-orders/:id/receive', async (req: AuthRequest, res: Response) => {
  try {
    const { receivedQuantity, invoiceNumber, damagedQuantity } = req.body;
    const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } }) as any;
    if (!po) return res.status(404).json({ error: 'Not found' });
    const qty = Number(receivedQuantity) || po.quantity;
    const grn = await createGRN(req, req.params.id, {
      quantityReceived: qty,
      quantityDamaged: damagedQuantity,
      supplierInvoiceNumber: invoiceNumber,
    });
    return res.json({ message: 'Goods received', grnNumber: grn.grnNumber });
  } catch (e: any) {
    return res.status(e.status || 500).json({ error: e.message });
  }
});

// B2: Create payment request for a received PO (enforces full procurement-to-payment chain)
router.post('/purchase-orders/:id/payment-request', async (req: AuthRequest, res: Response) => {
  try {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: req.params.id },
      include: { supplier: true, purchaseRequest: { include: { quotations: true } } },
    }) as any;
    if (!po) return res.status(404).json({ error: 'PO not found' });

    // Gating: PO must be received (GRN done)
    if (po.status !== 'received' && po.status !== 'partial') {
      return res.status(400).json({ error: `PO must be received (GRN done) before requesting payment. Current status: ${po.status}` });
    }
    // Gating: Must have invoice number
    if (!po.invoiceNumber) {
      return res.status(400).json({ error: 'Supplier invoice number must be recorded on the PO before requesting payment. Update the PO with invoiceNumber first.' });
    }
    // Check no existing payment request for this PO
    const existing = await prisma.paymentRequest.findFirst({
      where: { referenceType: 'po', referenceId: po.id, status: { notIn: ['rejected', 'closed'] } },
    });
    if (existing) {
      return res.status(400).json({ error: `Payment request already exists for this PO: ${(existing as any).requestNumber}` });
    }

    // Create payment request
    const requestNumber = await generatePaymentRequestNumber();

    const payReq = await prisma.paymentRequest.create({ data: {
      requestNumber,
      department: po.purchaseRequest?.department || 'store',
      requestedById: req.user?.id,
      paymentType: 'po_payment',
      payee: po.supplier?.name || 'Supplier',
      amount: po.totalAmount,
      description: `Payment for PO ${po.poNumber} - ${po.supplier?.name || 'Supplier'}`,
      referenceType: 'po',
      referenceId: po.id,
      supportingDoc: po.invoiceDocument || null,
      status: 'submitted', // Auto-submit since procurement chain is already approved
    }});

    return res.status(201).json({ paymentRequest: payReq });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;