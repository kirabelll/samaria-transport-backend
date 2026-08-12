import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import bcrypt from 'bcryptjs';
const router = Router();
router.use(authenticate);

// Orders routes (before /:id to avoid conflict)
router.get('/orders', async (req: AuthRequest, res: Response) => {
  try {
    const { status, orderType, customerId, page='1', limit='20' } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (orderType) where.orderType = orderType;
    if (customerId) where.customerId = customerId;
    const skip = (Number(page)-1)*Number(limit);
    const [orders, total] = await Promise.all([
      prisma.customerOrder.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' },
        include: { customer: { select: { companyName: true, contactName: true } } } }),
      prisma.customerOrder.count({ where }) ]);
    return res.json({ orders, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/orders', async (req: AuthRequest, res: Response) => {
  try {
    const { customerId, orderType, quantity, materialType, pickupLocation, deliveryLocation,
      pickupContact, pickupPhone, deliveryContact, deliveryPhone, deliveryGps,
      requiredDeliveryDate, ratePerTon, paymentType, poNumber, contractRef, notes } = req.body;
    if (!customerId || !orderType || !quantity || !pickupLocation || !deliveryLocation)
      return res.status(400).json({ error: 'customerId, orderType, quantity, pickupLocation, deliveryLocation required' });

    // Credit control check (#15)
    const customer = await prisma.customer.findUnique({ where: { id: customerId } }) as any;
    if (customer && customer.paymentType === 'credit' && customer.creditLimit > 0) {
      const outstandingInvoices = await prisma.invoice.findMany({
        where: { customerId, status: { in: ['unpaid', 'partial', 'overdue'] } },
        select: { balanceDue: true, invoiceDate: true },
      });
      const totalOutstanding = outstandingInvoices.reduce((s: number, i: any) => s + (i.balanceDue || 0), 0);
      const newOrderAmount = ratePerTon ? Number(quantity) * Number(ratePerTon) : 0;
      if (totalOutstanding + newOrderAmount > customer.creditLimit) {
        return res.status(400).json({
          error: 'Credit limit exceeded',
          creditLimit: customer.creditLimit, outstanding: totalOutstanding,
          orderAmount: newOrderAmount, available: customer.creditLimit - totalOutstanding,
        });
      }
      // Check overdue invoices
      const overdueInvoices = outstandingInvoices.filter((i: any) => {
        const daysSince = (Date.now() - new Date(i.invoiceDate).getTime()) / 86400000;
        return daysSince > (customer.creditDays || 30);
      });
      if (overdueInvoices.length > 0) {
        return res.status(400).json({
          error: `Customer has ${overdueInvoices.length} overdue invoice(s). Collect payment first.`,
          overdueCount: overdueInvoices.length,
        });
      }
    }

    const count = await prisma.customerOrder.count();
    const orderNumber = 'ORD-' + new Date().getFullYear() + '-' + String(count+1).padStart(6,'0');
    const route = `${pickupLocation} -> ${deliveryLocation}`;
    const order = await prisma.customerOrder.create({ data: {
      orderNumber, customerId, orderType, quantity: Number(quantity), materialType,
      pickupLocation, deliveryLocation, pickupContact, pickupPhone, deliveryContact,
      deliveryPhone, deliveryGps, ratePerTon: ratePerTon ? Number(ratePerTon) : undefined,
      totalAmount: ratePerTon ? Number(quantity)*Number(ratePerTon) : undefined,
      paymentType: paymentType||'cash', poNumber, contractRef, notes,
      requiredDeliveryDate: requiredDeliveryDate ? new Date(requiredDeliveryDate) : undefined,
      // Phase 1: Order Control fields
      route,
      deliverySite: req.body.deliverySite || null,
      itemProduct: req.body.itemProduct || null,
      remainingQty: Number(quantity),
      baseRate: ratePerTon ? Number(ratePerTon) : undefined,
      status: 'submitted' },
      include: { customer: { select: { companyName: true } } } });
    await prisma.orderStatusHistory.create({ data: { orderId: order.id, status: 'submitted', changedAt: new Date() } });
    return res.status(201).json({ order });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id', async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.customerOrder.findUnique({ where: { id: req.params.id },
      include: { customer: true, trips: { include: { vehicle: { select: { plateNumber: true } },
        driver: { select: { firstName: true, lastName: true } },
        statusHistory: { orderBy: { changedAt: 'desc' } } } },
        messages: { orderBy: { createdAt: 'asc' } }, statusHistory: { orderBy: { changedAt: 'desc' } }, invoice: true } });
    if (!order) return res.status(404).json({ error: 'Not found' });
    return res.json({ order });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/orders/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const { status, rejectionReason, scheduledDate } = req.body;
    if (!status) return res.status(400).json({ error: 'status required' });
    const order = await prisma.customerOrder.update({ where: { id: req.params.id },
      data: { status, rejectionReason: rejectionReason||null } });
    await prisma.orderStatusHistory.create({ data: { orderId: req.params.id, status, note: rejectionReason } });
    return res.json({ order });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/orders/:id/message', async (req: AuthRequest, res: Response) => {
  try {
    const { message, fromRole='office' } = req.body;
    const msg = await prisma.orderMessage.create({ data: { orderId: req.params.id, fromRole, message } });
    return res.status(201).json({ message: msg });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/orders/:id/messages', async (req: AuthRequest, res: Response) => {
  try {
    const messages = await prisma.orderMessage.findMany({ where: { orderId: req.params.id }, orderBy: { createdAt: 'asc' } });
    return res.json({ messages });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Order lifecycle - full view by order number
router.get('/orders/lifecycle/:orderNumber', async (req: AuthRequest, res: Response) => {
  try {
    const order = await prisma.customerOrder.findFirst({
      where: { orderNumber: req.params.orderNumber },
      include: {
        customer: true,
        trips: {
          include: {
            vehicle: { select: { plateNumber: true, make: true } },
            driver: { select: { firstName: true, lastName: true } },
            helper: { select: { firstName: true, lastName: true } },
            advances: true,
            fuelLogs: true,
            statusHistory: { orderBy: { changedAt: 'desc' } },
          },
          orderBy: { tripDate: 'desc' },
        },
        invoice: { include: { payments: true } },
        messages: { orderBy: { createdAt: 'asc' } },
        statusHistory: { orderBy: { changedAt: 'desc' } },
      },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // Aggregate trip financials
    const tripSummary = {
      totalTrips: order.trips.length,
      completedTrips: order.trips.filter((t: any) => t.status === 'completed').length,
      totalDelivered: order.trips.reduce((s: number, t: any) => s + (t.deliveredQuantityTons || 0), 0),
      totalRevenue: order.trips.reduce((s: number, t: any) => s + (t.revenue || 0), 0),
      totalShortage: order.trips.reduce((s: number, t: any) => s + (t.shortage || 0), 0),
      totalAdvances: order.trips.reduce((s: number, t: any) =>
        s + t.advances.reduce((as: number, a: any) => as + (a.status === 'paid' ? a.amount : 0), 0), 0),
      totalFuelCost: order.trips.reduce((s: number, t: any) =>
        s + t.fuelLogs.reduce((fs: number, f: any) => fs + (f.totalCost || 0), 0), 0),
      podCount: order.trips.filter((t: any) => t.podUrl || t.podDocument).length,
      confirmedCount: order.trips.filter((t: any) => t.customerConfirmationStatus === 'confirmed').length,
    };

    return res.json({ order, tripSummary });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Customer CRUD
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    const customers = await prisma.customer.findMany({ where, orderBy: { companyName: 'asc' } });
    return res.json({ customers });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const c = await prisma.customer.findUnique({ where: { id: req.params.id } });
    if (!c) return res.status(404).json({ error: 'Not found' });
    return res.json({ customer: c });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { companyName, contactName, phone, email, address, paymentType, creditLimit, creditDays, taxNumber } = req.body;
    if (!companyName || !contactName || !phone) return res.status(400).json({ error: 'companyName, contactName, phone required' });
    const customer = await prisma.customer.create({ data: {
      companyName, contactName, phone, email, address, paymentType: paymentType||'cash',
      creditLimit: Number(creditLimit)||0, creditDays: Number(creditDays)||0, taxNumber } });
    return res.status(201).json({ customer });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['companyName','contactName','phone','email','address','paymentType','taxNumber','status'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['creditLimit','creditDays']) if (req.body[f] !== undefined) data[f] = Number(req.body[f]);
    const customer = await prisma.customer.update({ where: { id: req.params.id }, data });
    return res.json({ customer });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Credit status for a customer (#15)
router.get('/:id/credit-status', async (req: AuthRequest, res: Response) => {
  try {
    const customer = await prisma.customer.findUnique({ where: { id: req.params.id } }) as any;
    if (!customer) return res.status(404).json({ error: 'Not found' });
    const invoices = await prisma.invoice.findMany({
      where: { customerId: req.params.id, status: { in: ['unpaid', 'partial', 'overdue'] } },
      select: { balanceDue: true, invoiceDate: true, status: true },
    });
    const totalOutstanding = invoices.reduce((s: number, i: any) => s + (i.balanceDue || 0), 0);
    const overdueCount = invoices.filter((i: any) => {
      const days = (Date.now() - new Date(i.invoiceDate).getTime()) / 86400000;
      return days > (customer.creditDays || 30);
    }).length;
    return res.json({
      creditLimit: customer.creditLimit || 0,
      creditDays: customer.creditDays || 30,
      paymentType: customer.paymentType,
      totalOutstanding,
      available: Math.max(0, (customer.creditLimit || 0) - totalOutstanding),
      invoicesCount: invoices.length,
      overdueCount,
      utilizationPct: customer.creditLimit > 0 ? Math.round(totalOutstanding / customer.creditLimit * 100) : 0,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id/orders', async (req: AuthRequest, res: Response) => {
  try {
    const orders = await prisma.customerOrder.findMany({ where: { customerId: req.params.id }, orderBy: { createdAt: 'desc' } });
    return res.json({ orders });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get('/:id/invoices', async (req: AuthRequest, res: Response) => {
  try {
    const invoices = await prisma.invoice.findMany({ where: { customerId: req.params.id }, orderBy: { invoiceDate: 'desc' } });
    return res.json({ invoices });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;