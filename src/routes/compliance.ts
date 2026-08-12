import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// Get all compliance alerts
router.get('/alerts', async (_req: AuthRequest, res: Response) => {
  try {
    const now = new Date();
    const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Vehicle compliance: insurance, inspection, permit, libre, bolo, road fund, roadworthiness
    const vehicles = await prisma.vehicle.findMany({
      where: { status: { not: 'inactive' } },
      select: { id: true, plateNumber: true, make: true, model: true,
        insuranceExpiry: true, inspectionExpiry: true, permitExpiry: true,
        libreExpiry: true, boloExpiry: true, roadFundExpiry: true, roadworthinessExpiry: true },
    });

    const vehicleAlerts: any[] = [];
    const checkExpiry = (v: any, field: string, label: string, type: string) => {
      const d = v[field] ? new Date(v[field]) : null;
      if (!d) return;
      const days = Math.ceil((d.getTime() - now.getTime()) / 86400000);
      if (d <= now) vehicleAlerts.push({ vehicleId: v.id, plateNumber: v.plateNumber, type, severity: 'critical', message: `${label} EXPIRED`, expiryDate: v[field], daysUntil: days });
      else if (d <= in7Days) vehicleAlerts.push({ vehicleId: v.id, plateNumber: v.plateNumber, type, severity: 'urgent', message: `${label} expires in ${days} days`, expiryDate: v[field], daysUntil: days });
      else if (d <= in30Days) vehicleAlerts.push({ vehicleId: v.id, plateNumber: v.plateNumber, type, severity: 'warning', message: `${label} expires in ${days} days`, expiryDate: v[field], daysUntil: days });
    };

    for (const v of vehicles) {
      checkExpiry(v, 'insuranceExpiry', 'Insurance', 'insurance_expiry');
      checkExpiry(v, 'inspectionExpiry', 'Inspection', 'inspection_due');
      checkExpiry(v, 'permitExpiry', 'Permit', 'permit_expiry');
      checkExpiry(v, 'libreExpiry', 'Libre', 'libre_expiry');
      checkExpiry(v, 'boloExpiry', 'Bolo', 'bolo_expiry');
      checkExpiry(v, 'roadFundExpiry', 'Road Fund', 'road_fund_expiry');
      checkExpiry(v, 'roadworthinessExpiry', 'Roadworthiness', 'roadworthiness_expiry');
    }

    // Driver document compliance
    const drivers = await prisma.employee.findMany({
      where: { role: 'driver', status: 'active' },
      select: { id: true, firstName: true, lastName: true, licenseExpiry: true, medicalCertExpiry: true, trainingValidUntil: true }
    });
    const driverAlerts: any[] = [];
    for (const d of drivers) {
      const driverName = `${d.firstName} ${d.lastName}`;
      if (d.licenseExpiry) {
        const exp = new Date(d.licenseExpiry);
        const days = Math.ceil((exp.getTime() - now.getTime()) / 86400000);
        if (exp <= now) driverAlerts.push({ driverId: d.id, driverName, type: 'license_expiry', severity: 'critical', message: 'Driving license EXPIRED', expiryDate: d.licenseExpiry, daysUntil: days });
        else if (exp <= in30Days) driverAlerts.push({ driverId: d.id, driverName, type: 'license_expiry', severity: 'warning', message: `License expires in ${days} days`, expiryDate: d.licenseExpiry, daysUntil: days });
      }
      if (d.medicalCertExpiry) {
        const exp = new Date(d.medicalCertExpiry);
        const days = Math.ceil((exp.getTime() - now.getTime()) / 86400000);
        if (exp <= now) driverAlerts.push({ driverId: d.id, driverName, type: 'medical_expiry', severity: 'critical', message: 'Medical certificate EXPIRED', expiryDate: d.medicalCertExpiry, daysUntil: days });
        else if (exp <= in30Days) driverAlerts.push({ driverId: d.id, driverName, type: 'medical_expiry', severity: 'warning', message: `Medical cert expires in ${days} days`, expiryDate: d.medicalCertExpiry, daysUntil: days });
      }
    }

    // Company document compliance
    const companyDocs = await prisma.companyDocument.findMany({
      where: { expiryDate: { not: null } }
    });
    const companyAlerts: any[] = [];
    for (const cd of companyDocs) {
      if (!cd.expiryDate) continue;
      const exp = new Date(cd.expiryDate);
      const days = Math.ceil((exp.getTime() - now.getTime()) / 86400000);
      if (days <= cd.alertBeforeDays) {
        companyAlerts.push({
          type: 'company_doc_expiry', documentType: cd.documentType, documentName: cd.documentName,
          severity: exp <= now ? 'critical' : days <= 7 ? 'urgent' : 'warning',
          message: exp <= now ? `${cd.documentName} EXPIRED` : `${cd.documentName} expires in ${days} days`,
          expiryDate: cd.expiryDate, daysUntil: days
        });
      }
    }

    // Maintenance due
    const maintenanceDue = await prisma.maintenanceSchedule.findMany({
      where: { OR: [{ status: 'overdue' }, { nextDueDate: { lte: in30Days } }] },
      include: { vehicle: { select: { plateNumber: true } } },
    });

    const maintenanceAlerts = maintenanceDue.map(m => ({
      vehicleId: m.vehicleId, plateNumber: m.vehicle.plateNumber,
      type: 'maintenance_' + m.maintenanceType,
      severity: m.status === 'overdue' ? 'critical' : (m.nextDueDate && new Date(m.nextDueDate) <= in7Days ? 'urgent' : 'warning'),
      message: `${m.maintenanceType.replace(/_/g, ' ')} ${m.status === 'overdue' ? 'OVERDUE' : 'due soon'}`,
      expiryDate: m.nextDueDate,
    }));

    // Rate contracts expiring
    const expiringContracts = await prisma.rateContract.findMany({
      where: { isActive: true, endDate: { lte: in30Days } },
      include: { customer: { select: { companyName: true } } },
    });

    const contractAlerts = expiringContracts.map(c => ({
      type: 'contract_expiry', severity: c.endDate && new Date(c.endDate) <= now ? 'critical' : 'warning',
      message: `Contract with ${c.customer.companyName} ${c.endDate && new Date(c.endDate) <= now ? 'EXPIRED' : 'expiring soon'}`,
      expiryDate: c.endDate,
    }));

    const allAlerts = [...vehicleAlerts, ...driverAlerts, ...companyAlerts, ...maintenanceAlerts, ...contractAlerts];
    allAlerts.sort((a, b) => {
      const sev: any = { critical: 0, urgent: 1, warning: 2 };
      return (sev[a.severity] || 3) - (sev[b.severity] || 3);
    });

    return res.json({
      alerts: allAlerts,
      summary: {
        critical: allAlerts.filter(a => a.severity === 'critical').length,
        urgent: allAlerts.filter(a => a.severity === 'urgent').length,
        warning: allAlerts.filter(a => a.severity === 'warning').length,
        total: allAlerts.length,
      }
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Unlock vehicle (admin override)
router.put('/vehicle/:id/unlock', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    const vehicle = await prisma.vehicle.findUnique({ where: { id: req.params.id } }) as any;
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    if (!vehicle.complianceLocked) return res.status(400).json({ error: 'Vehicle is not locked' });

    const updated = await prisma.vehicle.update({
      where: { id: req.params.id },
      data: { complianceLocked: false, lockReason: null, lockedAt: null, operationalStatus: 'idle' },
    });

    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'compliance_unlock', entityType: 'vehicle',
      entityId: vehicle.id,
      details: JSON.stringify({ plateNumber: vehicle.plateNumber, previousLockReason: vehicle.lockReason, unlockReason: reason || 'Admin override' }),
    }});

    return res.json({ vehicle: updated, message: 'Vehicle unlocked successfully' });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Update vehicle compliance dates
router.put('/vehicle/:id', async (req: AuthRequest, res: Response) => {
  try {
    const dateFields = ['insuranceExpiry','inspectionExpiry','permitExpiry','libreExpiry','boloExpiry','roadFundExpiry','roadworthinessExpiry'];
    const data: any = {};
    for (const f of dateFields) {
      if (req.body[f]) data[f] = new Date(req.body[f]);
    }
    const vehicle = await prisma.vehicle.update({ where: { id: req.params.id }, data });

    await prisma.auditLog.create({ data: {
      userId: req.user?.id, action: 'update', entityType: 'compliance',
      entityId: vehicle.id, details: JSON.stringify(data)
    }});

    return res.json({ vehicle });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
