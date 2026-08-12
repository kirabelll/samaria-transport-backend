import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

/**
 * GET /api/search?q=<ref>
 * Global reference search: matches trip/order/invoice/PO/WO/payment-request/settlement numbers.
 * Returns a prioritized list of matches with { type, id, label, url }.
 */
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const q = String((req.query as any).q || '').trim();
    if (!q) return res.json({ results: [] });
    const take = 15;
    const results: any[] = [];

    // Trips - TRP-xxx
    const trips = await prisma.trip.findMany({
      where: { OR: [{ tripNumber: { contains: q } }] },
      take, orderBy: { createdAt: 'desc' },
      select: { id: true, tripNumber: true, status: true, deliveryLocation: true },
    });
    trips.forEach(t => results.push({ type: 'Trip', id: t.id, label: t.tripNumber,
      subtitle: `${t.status} → ${t.deliveryLocation || ''}`, url: '/trips' }));

    // Orders - ORD-xxx  (also match PO numbers stored on orders)
    const orders = await prisma.customerOrder.findMany({
      where: { OR: [{ orderNumber: { contains: q } }, { poNumber: { contains: q } }] },
      take, orderBy: { createdAt: 'desc' },
      select: { id: true, orderNumber: true, poNumber: true, status: true },
    });
    orders.forEach(o => results.push({ type: 'Order', id: o.id,
      label: o.orderNumber + (o.poNumber ? ` · PO ${o.poNumber}` : ''),
      subtitle: o.status, url: '/orders' }));

    // Purchase Orders
    try {
      const pos = await (prisma as any).purchaseOrder.findMany({
        where: { OR: [{ poNumber: { contains: q } }] },
        take, orderBy: { createdAt: 'desc' },
        select: { id: true, poNumber: true, status: true },
      });
      pos.forEach((p: any) => results.push({ type: 'PO', id: p.id,
        label: p.poNumber, subtitle: p.status, url: '/procurement' }));
    } catch {}

    // Work Orders (maintenance)
    try {
      const wos = await (prisma as any).workOrder.findMany({
        where: { OR: [{ workOrderNumber: { contains: q } }] },
        take, orderBy: { createdAt: 'desc' },
        select: { id: true, workOrderNumber: true, status: true },
      });
      wos.forEach((w: any) => results.push({ type: 'WO', id: w.id,
        label: w.workOrderNumber, subtitle: w.status, url: '/maintenance' }));
    } catch {}

    // Payment Requests
    try {
      const prs = await (prisma as any).paymentRequest.findMany({
        where: { OR: [{ requestNumber: { contains: q } }] },
        take, orderBy: { createdAt: 'desc' },
        select: { id: true, requestNumber: true, status: true, amount: true },
      });
      prs.forEach((p: any) => results.push({ type: 'PaymentReq', id: p.id,
        label: p.requestNumber, subtitle: `${p.status} · ${p.amount}`, url: '/payment-requests' }));
    } catch {}

    // Invoices (via settlement)
    try {
      const invoices = await (prisma as any).settlement.findMany({
        where: { OR: [{ invoiceNumber: { contains: q } }, { settlementNumber: { contains: q } }] },
        take, orderBy: { createdAt: 'desc' },
        select: { id: true, invoiceNumber: true, settlementNumber: true, status: true },
      });
      invoices.forEach((s: any) => results.push({ type: 'Settlement', id: s.id,
        label: s.invoiceNumber || s.settlementNumber,
        subtitle: s.status, url: '/settlements' }));
    } catch {}

    // Vehicles (by plate)
    const vehicles = await prisma.vehicle.findMany({
      where: { OR: [{ plateNumber: { contains: q } }] },
      take: 8, orderBy: { createdAt: 'desc' },
      select: { id: true, plateNumber: true, make: true, model: true, status: true },
    });
    vehicles.forEach(v => results.push({ type: 'Vehicle', id: v.id,
      label: v.plateNumber, subtitle: `${v.make || ''} ${v.model || ''} (${v.status})`.trim(),
      url: '/vehicles' }));

    return res.json({ results: results.slice(0, 30) });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
