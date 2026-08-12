import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';

const router = Router();

const MELLA_API_URL = 'https://mellatech.et/et/api/api.php';
const MELLA_API_KEY = '9B5D70B12BB8D5E693C5534780C5343A';

// GET /api/tracking/vehicles - get all vehicles from Mella GPS
router.get('/vehicles', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const url = `${MELLA_API_URL}?api=user&ver=1.0&key=${MELLA_API_KEY}&cmd=USER_GET_OBJECTS`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Mella API returned ${response.status}`);
    const data: any = await response.json();
    return res.json({ vehicles: data, count: data.length });
  } catch (e: any) {
    return res.status(500).json({ error: `GPS API error: ${e.message}` });
  }
});

// GET /api/tracking/vehicles/:imei - get single vehicle details
router.get('/vehicles/:imei', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const url = `${MELLA_API_URL}?api=user&ver=1.0&key=${MELLA_API_KEY}&cmd=USER_GET_OBJECTS`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Mella API returned ${response.status}`);
    const data: any = await response.json();
    const vehicle = data.find((v: any) => v.imei === req.params.imei);
    if (!vehicle) return res.status(404).json({ error: 'Vehicle not found' });
    return res.json({ vehicle });
  } catch (e: any) {
    return res.status(500).json({ error: `GPS API error: ${e.message}` });
  }
});

// GET /api/tracking/import-preview - preview GPS vehicles available for import
router.get('/import-preview', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const url = `${MELLA_API_URL}?api=user&ver=1.0&key=${MELLA_API_KEY}&cmd=USER_GET_OBJECTS`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Mella API returned ${response.status}`);
    const gpsVehicles = (await response.json()) as any[];

    // Get existing vehicles from DB
    const existingVehicles = await prisma.vehicle.findMany({
      select: { plateNumber: true, gpsImei: true },
    });
    const existingPlates = new Set(existingVehicles.map(v => v.plateNumber.toLowerCase().replace(/[\s-]/g, '')));
    const existingImeis = new Set(existingVehicles.filter(v => v.gpsImei).map(v => v.gpsImei));

    const results = gpsVehicles.map((gv: any) => {
      const name = gv.name || '';
      const normalizedName = name.toLowerCase().replace(/[\s-]/g, '');
      const alreadyLinked = existingImeis.has(gv.imei);
      const plateMatch = existingPlates.has(normalizedName);
      return {
        imei: gv.imei,
        name: gv.name,
        group: gv.group,
        odometer: gv.odometer,
        status: alreadyLinked ? 'linked' : plateMatch ? 'plate_exists' : 'new',
      };
    });

    return res.json({
      gpsVehicles: results,
      summary: {
        total: results.length,
        new: results.filter(r => r.status === 'new').length,
        linked: results.filter(r => r.status === 'linked').length,
        plateExists: results.filter(r => r.status === 'plate_exists').length,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: `GPS API error: ${e.message}` });
  }
});

// POST /api/tracking/import - import selected GPS vehicles into the ERP
router.post('/import', authenticate, async (req: AuthRequest, res: Response) => {
  try {
    const { imeis } = req.body; // array of IMEI strings to import

    const url = `${MELLA_API_URL}?api=user&ver=1.0&key=${MELLA_API_KEY}&cmd=USER_GET_OBJECTS`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Mella API returned ${response.status}`);
    const gpsVehicles = (await response.json()) as any[];

    // Filter to selected IMEIs
    const toImport = imeis && imeis.length > 0
      ? gpsVehicles.filter((v: any) => imeis.includes(v.imei))
      : gpsVehicles;

    // Get existing to avoid duplicates
    const existing = await prisma.vehicle.findMany({
      select: { plateNumber: true, gpsImei: true },
    });
    const existingImeis = new Set(existing.filter(v => v.gpsImei).map(v => v.gpsImei));
    const existingPlates = new Set(existing.map(v => v.plateNumber.toLowerCase().replace(/[\s-]/g, '')));

    const results: any[] = [];
    for (const gv of toImport) {
      const name = gv.name || `GPS-${gv.imei}`;
      const normalizedName = name.toLowerCase().replace(/[\s-]/g, '');

      if (existingImeis.has(gv.imei)) {
        results.push({ name, imei: gv.imei, status: 'skipped', reason: 'Already linked' });
        continue;
      }

      // If plate number matches existing vehicle, link them
      if (existingPlates.has(normalizedName)) {
        const match = existing.find(e => e.plateNumber.toLowerCase().replace(/[\s-]/g, '') === normalizedName);
        if (match) {
          await prisma.vehicle.updateMany({
            where: { plateNumber: match.plateNumber },
            data: { gpsImei: gv.imei, currentKm: Math.round(Number(gv.odometer) || 0) },
          });
          results.push({ name, imei: gv.imei, status: 'linked', reason: 'Linked to existing vehicle' });
          continue;
        }
      }

      // Guess category from group name
      let category = 'cement_tanker';
      const groupLower = (gv.group || '').toLowerCase();
      if (groupLower.includes('tipper') || groupLower.includes('gravel')) category = 'gravel_tipper';
      else if (groupLower.includes('office') || groupLower.includes('car')) category = 'office_car';
      else if (groupLower.includes('pickup')) category = 'office_pickup';
      else if (groupLower.includes('minibus')) category = 'minibus';

      // Create new vehicle
      const plateNumber = name; // GPS name is typically the plate number
      const count = await prisma.vehicle.count();
      await prisma.vehicle.create({
        data: {
          plateNumber,
          make: 'Unknown',
          model: 'Unknown',
          category,
          year: new Date().getFullYear(),
          status: 'active',
          gpsImei: gv.imei,
          currentKm: Math.round(Number(gv.odometer) || 0),
        },
      });
      results.push({ name, imei: gv.imei, status: 'created', reason: 'New vehicle created' });
    }

    return res.json({
      results,
      summary: {
        created: results.filter(r => r.status === 'created').length,
        linked: results.filter(r => r.status === 'linked').length,
        skipped: results.filter(r => r.status === 'skipped').length,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: `Import error: ${e.message}` });
  }
});

export default router;
