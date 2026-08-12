import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

const router = Router();
router.use(authenticate);

// Setup multer for file uploads
const uploadDir = path.join(__dirname, '../../uploads/documents');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).substr(2, 8)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB

// Upload document
router.post('/', upload.single('file'), async (req: AuthRequest, res: Response) => {
  try {
    const { entityType, entityId, category, expiryDate, notes } = req.body;
    if (!entityType || !entityId) return res.status(400).json({ error: 'entityType, entityId required' });
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'File is required' });
    const doc = await prisma.document.create({ data: {
      entityType, entityId, category: category || 'general',
      fileName: file.originalname, filePath: `/uploads/documents/${file.filename}`,
      fileSize: file.size, mimeType: file.mimetype,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      notes, uploadedBy: req.user?.id || '',
    }});
    return res.status(201).json({ document: doc });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// List documents for an entity
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { entityType, entityId, category } = req.query as any;
    const where: any = {};
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (category) where.category = category;
    const documents = await prisma.document.findMany({ where, orderBy: { createdAt: 'desc' } });
    return res.json({ documents });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Get expiring documents (within 30 days)
router.get('/expiring', async (req: AuthRequest, res: Response) => {
  try {
    const { days = '30' } = req.query as any;
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + Number(days));
    const documents = await prisma.document.findMany({
      where: { expiryDate: { not: null, lte: futureDate } },
      orderBy: { expiryDate: 'asc' },
    });
    const expired = documents.filter((d: any) => d.expiryDate && new Date(d.expiryDate) < new Date());
    const expiringSoon = documents.filter((d: any) => d.expiryDate && new Date(d.expiryDate) >= new Date());
    return res.json({ documents, expired: expired.length, expiringSoon: expiringSoon.length });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Delete document
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    // Delete file
    const filePath = path.join(__dirname, '../..', doc.filePath);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await prisma.document.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
