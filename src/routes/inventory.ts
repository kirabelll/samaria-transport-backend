import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { sendNotification } from '../utils/telegram';
const router = Router();
router.use(authenticate);

router.get('/spare-part-requests', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    const requests = await prisma.sparePartRequest.findMany({ where, orderBy: { createdAt: 'desc' },
      include: { inventory: { select: { partName: true } },
        workOrder: { select: { workOrderNumber: true } } } });
    return res.json({ requests });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/spare-part-requests', async (req: AuthRequest, res: Response) => {
  try {
    const { workOrderId, inventoryId, partName, partNumber, quantityNeeded, notes } = req.body;
    if (!partName || !quantityNeeded) return res.status(400).json({ error: 'partName, quantityNeeded required' });
    const r = await prisma.sparePartRequest.create({ data: {
      workOrderId: workOrderId||null, inventoryId: inventoryId||null,
      partName, partNumber, quantityNeeded: Number(quantityNeeded), notes, status: 'pending' } });
    return res.status(201).json({ request: r });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/spare-part-requests/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const { approved, quantityIssued } = req.body;
    const r = await prisma.sparePartRequest.findUnique({ where: { id: req.params.id } }) as any;
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (approved && r.inventoryId) {
      const qty = Number(quantityIssued) || r.quantityNeeded;
      const inv = await prisma.inventory.findUnique({ where: { id: r.inventoryId } }) as any;
      if (!inv) return res.status(404).json({ error: 'Inventory item not found' });
      if (inv.quantityInStock < qty) return res.status(400).json({ error: 'Insufficient stock' });
      await prisma.$transaction(async (tx: any) => {
        await tx.inventory.update({ where: { id: r.inventoryId }, data: {
          quantityInStock: { decrement: qty },
          totalValue: (inv.quantityInStock - qty) * inv.unitCost } });
        await tx.inventoryTransaction.create({ data: { inventoryId: r.inventoryId, type: 'out',
          quantity: qty, unitCost: inv.unitCost, totalCost: qty * inv.unitCost,
          workOrderId: r.workOrderId || null, reference: 'spare_part_request' } });
        await tx.sparePartRequest.update({ where: { id: req.params.id }, data: {
          status: 'issued', quantityIssued: qty, unitCost: inv.unitCost,
          totalCost: qty * inv.unitCost, approvedById: req.user?.id,
          approvedAt: new Date(), issuedAt: new Date() } });
      });
      return res.json({ message: 'Parts issued' });
    }
    const updated = await prisma.sparePartRequest.update({ where: { id: req.params.id },
      data: { status: approved ? 'approved' : 'cancelled', approvedById: req.user?.id, approvedAt: new Date() } });
    return res.json({ request: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { category, lowStock } = req.query as any;
    const where: any = {};
    if (category) where.category = category;
    const items = await prisma.inventory.findMany({ where, orderBy: { partName: 'asc' } });
    const filtered = lowStock === 'true' ? items.filter((i: any) => i.quantityInStock <= i.minimumStock) : items;
    return res.json({ items: filtered });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const item = await prisma.inventory.findUnique({ where: { id: req.params.id },
      include: { transactions: { orderBy: { createdAt: 'desc' }, take: 20 } } });
    if (!item) return res.status(404).json({ error: 'Not found' });
    return res.json({ item });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { partName, partNumber, category, unit, quantityInStock, minimumStock, unitCost, location, supplier } = req.body;
    if (!partName || !category) return res.status(400).json({ error: 'partName, category required' });
    const qty = Number(quantityInStock)||0, cost = Number(unitCost)||0;
    const item = await prisma.inventory.create({ data: {
      partName, partNumber: partNumber||null, category, unit: unit||'pcs',
      quantityInStock: qty, minimumStock: Number(minimumStock)||0,
      unitCost: cost, totalValue: qty*cost, location, supplier } });
    return res.status(201).json({ item });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['partName','partNumber','category','unit','location','supplier'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['quantityInStock','minimumStock','unitCost'])
      if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    const item = await prisma.inventory.update({ where: { id: req.params.id }, data });
    return res.json({ item });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/:id/issue', async (req: AuthRequest, res: Response) => {
  try {
    const { quantity, vehicleId, workOrderId, notes } = req.body;
    if (!quantity) return res.status(400).json({ error: 'quantity required' });
    const inv = await prisma.inventory.findUnique({ where: { id: req.params.id } }) as any;
    if (!inv) return res.status(404).json({ error: 'Not found' });
    if (inv.quantityInStock < Number(quantity)) return res.status(400).json({ error: 'Insufficient stock' });
    const qty = Number(quantity);
    await prisma.$transaction(async (tx: any) => {
      await tx.inventory.update({ where: { id: req.params.id }, data: {
        quantityInStock: { decrement: qty }, totalValue: (inv.quantityInStock - qty) * inv.unitCost } });
      await tx.inventoryTransaction.create({ data: { inventoryId: req.params.id, vehicleId: vehicleId||null,
        type: 'out', quantity: qty, unitCost: inv.unitCost, totalCost: qty*inv.unitCost,
        workOrderId: workOrderId||null, notes } });
    });
    // Telegram: alert if stock falls below minimum
    const updated = await prisma.inventory.findUnique({ where: { id: req.params.id } });
    if (updated && updated.quantityInStock <= updated.minimumStock && updated.minimumStock > 0) {
      sendNotification('warning', 'inventory',
        `Low Stock: ${updated.partName}`,
        `Current: ${updated.quantityInStock} ${updated.unit} | Minimum: ${updated.minimumStock} ${updated.unit}`
      ).catch(() => {});
    }

    return res.json({ message: 'Issued successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/:id/receive', async (req: AuthRequest, res: Response) => {
  try {
    const { quantity, unitCost, purchaseOrderId, notes } = req.body;
    if (!quantity) return res.status(400).json({ error: 'quantity required' });
    const inv = await prisma.inventory.findUnique({ where: { id: req.params.id } }) as any;
    if (!inv) return res.status(404).json({ error: 'Not found' });
    const qty = Number(quantity), cost = Number(unitCost)||inv.unitCost;
    await prisma.$transaction(async (tx: any) => {
      const newQty = inv.quantityInStock + qty;
      await tx.inventory.update({ where: { id: req.params.id }, data: {
        quantityInStock: { increment: qty }, unitCost: cost, totalValue: newQty * cost } });
      await tx.inventoryTransaction.create({ data: { inventoryId: req.params.id, type: 'in',
        quantity: qty, unitCost: cost, totalCost: qty*cost,
        purchaseOrderId: purchaseOrderId||null, notes } });
    });
    return res.json({ message: 'Received successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// PART RETURN / OLD PART CONTROL
// ════════════════════════════════════════════════════════════════════════════
router.get('/part-returns', async (req: AuthRequest, res: Response) => {
  try {
    const { vehiclePlate } = req.query as Record<string, string>;
    const where: any = {};
    if (vehiclePlate) where.vehiclePlate = { contains: vehiclePlate };
    const returns = await prisma.partReturn.findMany({ where, orderBy: { createdAt: 'desc' } });
    return res.json({ returns });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/part-returns', async (req: AuthRequest, res: Response) => {
  try {
    const { inventoryId, vehicleId, vehiclePlate, partName, partNumber, serialNumber,
      oldPartSerial, newPartSerial, quantity, returnedToStore, condition, workOrderId, notes } = req.body;
    if (!partName) return res.status(400).json({ error: 'partName required' });

    const partReturn = await prisma.partReturn.create({
      data: {
        inventoryId, vehicleId, vehiclePlate, partName, partNumber, serialNumber,
        oldPartSerial, newPartSerial,
        quantity: Number(quantity) || 1,
        returnedToStore: returnedToStore || false,
        condition, workOrderId, notes
      }
    });

    // If returned to store, add back to inventory
    if (returnedToStore && inventoryId) {
      await prisma.inventory.update({
        where: { id: inventoryId },
        data: { quantityInStock: { increment: Number(quantity) || 1 } }
      });
      await prisma.inventoryTransaction.create({
        data: {
          inventoryId, type: 'return',
          quantity: Number(quantity) || 1,
          unitCost: 0, totalCost: 0,
          vehicleId, notes: `Old part returned: ${oldPartSerial || partName}. Condition: ${condition || 'N/A'}`
        }
      });
    }

    return res.status(201).json({ partReturn });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/part-returns/:id/verify', async (req: AuthRequest, res: Response) => {
  try {
    const partReturn = await prisma.partReturn.update({
      where: { id: req.params.id },
      data: { verifiedBy: req.user?.id, verifiedAt: new Date() }
    });
    return res.json({ partReturn });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// ENHANCED INVENTORY LIST with reorder alerts
// ════════════════════════════════════════════════════════════════════════════
router.get('/low-stock', async (req: AuthRequest, res: Response) => {
  try {
    const items = await prisma.inventory.findMany({
      where: { isActive: true }
    });
    const lowStock = items.filter((i: any) => {
      const threshold = i.reorderPoint || i.minimumStock || 0;
      return threshold > 0 && i.quantityInStock <= threshold;
    }).map((i: any) => ({
      ...i,
      reorderNeeded: true,
      belowMinimum: i.minimumStock > 0 && i.quantityInStock <= i.minimumStock,
      belowReorder: i.reorderPoint && i.quantityInStock <= i.reorderPoint
    }));
    return res.json({ items: lowStock, count: lowStock.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Inventory movement report
router.get('/movement-report', async (req: AuthRequest, res: Response) => {
  try {
    const { from, to, inventoryId } = req.query as Record<string, string>;
    const where: any = {};
    if (inventoryId) where.inventoryId = inventoryId;
    if (from || to) { where.createdAt = {}; if (from) where.createdAt.gte = new Date(from); if (to) where.createdAt.lte = new Date(to); }
    const transactions = await prisma.inventoryTransaction.findMany({
      where, orderBy: { createdAt: 'desc' },
      include: {
        inventory: { select: { partName: true, partNumber: true, unit: true } },
        vehicle: { select: { plateNumber: true } }
      }
    });
    const totalIn = transactions.filter(t => t.type === 'in' || t.type === 'return').reduce((s, t) => s + t.quantity, 0);
    const totalOut = transactions.filter(t => t.type === 'out').reduce((s, t) => s + t.quantity, 0);
    return res.json({ transactions, totalIn, totalOut, totalMovements: transactions.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;