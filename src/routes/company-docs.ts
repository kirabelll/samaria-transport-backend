import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();
router.use(authenticate);

// GET /company-docs
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, type } = req.query as Record<string, string>;
    const where: any = {};
    if (status) where.status = status;
    if (type) where.documentType = type;

    // Auto-update expired status
    await prisma.companyDocument.updateMany({
      where: { status: 'active', expiryDate: { lt: new Date() } },
      data: { status: 'expired' }
    });

    const docs = await prisma.companyDocument.findMany({ where, orderBy: { expiryDate: 'asc' } });
    return res.json({ documents: docs });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// POST /company-docs
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { documentType, documentName, documentNumber, issueDate, expiryDate,
      issuingAuthority, filePath, alertBeforeDays, notes } = req.body;
    if (!documentType || !documentName) return res.status(400).json({ error: 'documentType, documentName required' });
    const doc = await prisma.companyDocument.create({
      data: {
        documentType, documentName, documentNumber, issuingAuthority, filePath, notes,
        issueDate: issueDate ? new Date(issueDate) : null,
        expiryDate: expiryDate ? new Date(expiryDate) : null,
        alertBeforeDays: Number(alertBeforeDays) || 30,
        status: 'active'
      }
    });
    return res.status(201).json({ document: doc });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /company-docs/:id
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const data: any = {};
    for (const f of ['documentType','documentName','documentNumber','issuingAuthority','filePath','notes','status'])
      if (req.body[f] !== undefined) data[f] = req.body[f];
    if (req.body.alertBeforeDays !== undefined) data.alertBeforeDays = Number(req.body.alertBeforeDays);
    if (req.body.issueDate) data.issueDate = new Date(req.body.issueDate);
    if (req.body.expiryDate) data.expiryDate = new Date(req.body.expiryDate);
    const doc = await prisma.companyDocument.update({ where: { id: req.params.id }, data });
    return res.json({ document: doc });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /company-docs/expiring - docs expiring soon
router.get('/expiring', async (req: AuthRequest, res: Response) => {
  try {
    const docs = await prisma.companyDocument.findMany({
      where: { status: { not: 'expired' }, expiryDate: { not: null } },
      orderBy: { expiryDate: 'asc' }
    });
    const now = new Date();
    const expiring = docs.filter((d: any) => {
      if (!d.expiryDate) return false;
      const daysUntil = Math.floor((new Date(d.expiryDate).getTime() - now.getTime()) / 86400000);
      return daysUntil <= d.alertBeforeDays;
    }).map((d: any) => ({
      ...d,
      daysUntilExpiry: Math.floor((new Date(d.expiryDate!).getTime() - now.getTime()) / 86400000)
    }));
    return res.json({ expiring });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Contract expiry tracking
router.get('/contract-expiry', async (req: AuthRequest, res: Response) => {
  try {
    await prisma.contractExpiry.updateMany({
      where: { status: 'active', expiryDate: { lt: new Date() } },
      data: { status: 'expired' }
    });
    const contracts = await prisma.contractExpiry.findMany({ orderBy: { expiryDate: 'asc' } });
    return res.json({ contracts });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.post('/contract-expiry', async (req: AuthRequest, res: Response) => {
  try {
    const { contractType, entityType, entityId, entityName, contractRef, startDate, expiryDate, alertBeforeDays, notes } = req.body;
    if (!contractType || !entityName || !expiryDate) return res.status(400).json({ error: 'contractType, entityName, expiryDate required' });
    const entry = await prisma.contractExpiry.create({
      data: {
        contractType, entityType: entityType || 'other', entityId: entityId || '',
        entityName, contractRef,
        startDate: startDate ? new Date(startDate) : null,
        expiryDate: new Date(expiryDate),
        alertBeforeDays: Number(alertBeforeDays) || 30,
        notes, status: 'active'
      }
    });
    return res.status(201).json({ entry });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
