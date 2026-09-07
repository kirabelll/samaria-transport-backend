import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import { generateOrderNumber } from '../utils/sequence-generator';
const router = Router();
router.use(authenticate);

// Portal dashboard: customer's own summary
router.get('/dashboard', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } }) as any;
    if (!user?.customerId) return res.status(403).json({ error: 'No customer linked to account' });

    const [orders, activeTrips, invoices, customer] = await Promise.all([
      prisma.customerOrder.findMany({ where: { customerId: user.customerId }, orderBy: { createdAt: 'desc' }, take: 5 }),
      prisma.trip.findMany({ where: { customerId: user.customerId, status: { notIn: ['completed', 'cancelled'] } },
        include: { vehicle: { select: { plateNumber: true } }, driver: { select: { firstName: true, lastName: true } } } }),
      prisma.invoice.findMany({ where: { customerId: user.customerId, status: { in: ['unpaid', 'partial', 'overdue'] } } }),
      prisma.customer.findUnique({ where: { id: user.customerId } }),
    ]);

    const totalOrders = await prisma.customerOrder.count({ where: { customerId: user.customerId } });
    const completedOrders = await prisma.customerOrder.count({ where: { customerId: user.customerId, status: 'delivered' } });
    const totalInvoiced = invoices.reduce((s: number, i: any) => s + (i.totalAmount || 0), 0);
    const totalOutstanding = invoices.reduce((s: number, i: any) => s + (i.balanceDue || 0), 0);

    return res.json({
      customer, totalOrders, completedOrders,
      activeOrders: orders.filter(o => !['delivered', 'cancelled'].includes(o.status)).length,
      totalInvoiced, totalOutstanding,
      recentOrders: orders, activeTrips, pendingInvoices: invoices,
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Portal orders: list customer's orders
router.get('/orders', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } }) as any;
    if (!user?.customerId) return res.status(403).json({ error: 'No customer linked' });
    const { status, page = '1', limit = '20' } = req.query as any;
    const where: any = { customerId: user.customerId };
    if (status) where.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [orders, total] = await Promise.all([
      prisma.customerOrder.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' } }),
      prisma.customerOrder.count({ where }),
    ]);
    return res.json({ orders, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Portal: create order
router.post('/orders', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } }) as any;
    if (!user?.customerId) return res.status(403).json({ error: 'No customer linked' });
    const { orderType, quantity, materialType, pickupLocation, deliveryLocation,
      pickupContact, pickupPhone, deliveryContact, deliveryPhone, deliveryGps,
      requiredDeliveryDate, notes } = req.body;
    if (!orderType || !quantity || !pickupLocation || !deliveryLocation)
      return res.status(400).json({ error: 'orderType, quantity, pickupLocation, deliveryLocation required' });
    const orderNumber = await generateOrderNumber();
    const order = await prisma.customerOrder.create({ data: {
      orderNumber, customerId: user.customerId, orderType, quantity: Number(quantity),
      materialType, pickupLocation, deliveryLocation, pickupContact, pickupPhone,
      deliveryContact, deliveryPhone, deliveryGps,
      requiredDeliveryDate: requiredDeliveryDate ? new Date(requiredDeliveryDate) : undefined,
      notes, status: 'submitted',
    }});
    await prisma.orderStatusHistory.create({ data: { orderId: order.id, status: 'submitted' } });
    return res.status(201).json({ order });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Portal: order detail with tracking
router.get('/orders/:id', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } }) as any;
    if (!user?.customerId) return res.status(403).json({ error: 'No customer linked' });
    const order = await prisma.customerOrder.findFirst({
      where: { id: req.params.id, customerId: user.customerId },
      include: {
        trips: { include: { vehicle: { select: { plateNumber: true } }, driver: { select: { firstName: true, lastName: true } } } },
        messages: { orderBy: { createdAt: 'asc' } },
        statusHistory: { orderBy: { changedAt: 'desc' } },
        invoice: true,
      },
    });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    return res.json({ order });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Portal: send message on order
router.post('/orders/:id/message', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } }) as any;
    if (!user?.customerId) return res.status(403).json({ error: 'No customer linked' });
    const order = await prisma.customerOrder.findFirst({ where: { id: req.params.id, customerId: user.customerId } });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    const { message } = req.body;
    const msg = await prisma.orderMessage.create({ data: { orderId: req.params.id, fromRole: 'customer', message } });
    return res.status(201).json({ message: msg });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Portal: invoices
router.get('/invoices', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } }) as any;
    if (!user?.customerId) return res.status(403).json({ error: 'No customer linked' });
    const invoices = await prisma.invoice.findMany({
      where: { customerId: user.customerId }, orderBy: { invoiceDate: 'desc' },
    });
    return res.json({ invoices });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Portal: profile
router.get('/profile', async (req: AuthRequest, res: Response) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user?.id } }) as any;
    if (!user?.customerId) return res.status(403).json({ error: 'No customer linked' });
    const customer = await prisma.customer.findUnique({ where: { id: user.customerId } });
    return res.json({ customer, user: { name: user.name, email: user.email } });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
