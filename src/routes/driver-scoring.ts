import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// Get scoring config
router.get('/config', async (req: AuthRequest, res: Response) => {
  try {
    let config = await prisma.driverScoreConfig.findFirst();
    if (!config) {
      config = await prisma.driverScoreConfig.create({ data: {
        tripCountWeight: 20, shortageWeight: 25, cycleTimeWeight: 20,
        fuelEfficiencyWeight: 15, attendanceWeight: 10, safetyWeight: 10,
      }});
    }
    return res.json({ config });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Update scoring config
router.put('/config', async (req: AuthRequest, res: Response) => {
  try {
    const config = await prisma.driverScoreConfig.findFirst();
    if (!config) return res.status(404).json({ error: 'Config not found' });
    const updated = await prisma.driverScoreConfig.update({ where: { id: config.id }, data: req.body });
    return res.json({ config: updated });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Calculate & store monthly scores
router.post('/calculate', async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.body;
    const m = month || new Date().getMonth() + 1;
    const y = year || new Date().getFullYear();
    const monthStart = new Date(y, m - 1, 1);
    const monthEnd = new Date(y, m, 0, 23, 59, 59);

    const config = await prisma.driverScoreConfig.findFirst() as any;
    if (!config) return res.status(400).json({ error: 'Configure scoring weights first' });

    const drivers = await prisma.employee.findMany({ where: { role: 'driver', status: 'active' } });
    const scores = [];

    for (const driver of drivers) {
      const trips = await prisma.trip.findMany({
        where: { driverId: driver.id, tripDate: { gte: monthStart, lte: monthEnd }, status: 'completed' },
      });

      // Trip count score (0-100): based on trip count vs fleet avg
      const allDriverTrips = await prisma.trip.count({
        where: { tripDate: { gte: monthStart, lte: monthEnd }, status: 'completed' },
      });
      const driverCount = await prisma.employee.count({ where: { role: 'driver', status: 'active' } });
      const avgTrips = driverCount > 0 ? allDriverTrips / driverCount : 1;
      const tripScore = Math.min(100, Math.round((trips.length / Math.max(avgTrips, 1)) * 100));

      // Shortage score (100 - shortage%): lower shortage = higher score
      const totalLoaded = trips.reduce((s: number, t: any) => s + (t.loadedQuantityTons || t.plannedQuantityTons || 0), 0);
      const totalShortage = trips.reduce((s: number, t: any) => s + (t.shortage || 0), 0);
      const shortageScore = totalLoaded > 0 ? Math.max(0, Math.round(100 - (totalShortage / totalLoaded * 100))) : 100;

      // Cycle time score: faster than avg = higher
      const cycleTrips = trips.filter((t: any) => t.totalCycleMinutes);
      const avgCycle = cycleTrips.length > 0
        ? cycleTrips.reduce((s: number, t: any) => s + t.totalCycleMinutes, 0) / cycleTrips.length : 0;
      const fleetAvgCycle = await prisma.trip.aggregate({
        where: { tripDate: { gte: monthStart, lte: monthEnd }, status: 'completed', totalCycleMinutes: { not: null } },
        _avg: { totalCycleMinutes: true },
      });
      const fleetAvg = (fleetAvgCycle._avg as any)?.totalCycleMinutes || avgCycle || 1;
      const cycleScore = avgCycle > 0 ? Math.min(100, Math.round((fleetAvg / avgCycle) * 100)) : 50;

      // Fuel efficiency score
      const fuelLogs = await prisma.fuelLog.findMany({
        where: { driverId: driver.id, date: { gte: monthStart, lte: monthEnd } },
      });
      const totalFuel = fuelLogs.reduce((s: number, f: any) => s + (f.liters || 0), 0);
      const fuelPerTon = totalLoaded > 0 && totalFuel > 0 ? totalFuel / totalLoaded : 0;
      const fuelScore = fuelPerTon > 0 ? Math.min(100, Math.round(50 / fuelPerTon * 10)) : 50;

      // Attendance score
      const attendance = await prisma.attendance.findMany({
        where: { employeeId: driver.id, date: { gte: monthStart, lte: monthEnd } },
      });
      const presentDays = attendance.filter((a: any) => a.status === 'present').length;
      const totalDays = attendance.length || 26;
      const attendanceScore = Math.min(100, Math.round((presentDays / totalDays) * 100));

      // Safety score (default 80 if no data)
      const safetyScore = 80;

      // Weighted total
      const totalScore = Math.round(
        (tripScore * config.tripCountWeight +
         shortageScore * config.shortageWeight +
         cycleScore * config.cycleTimeWeight +
         fuelScore * config.fuelEfficiencyWeight +
         attendanceScore * config.attendanceWeight +
         safetyScore * config.safetyWeight) / 100
      );

      // Upsert score
      const existing = await prisma.driverScore.findFirst({
        where: { driverId: driver.id, month: m, year: y },
      });
      const scoreFields = {
        tripCount: trips.length, totalScore,
        tripScore, shortageScore, cycleTimeScore: cycleScore,
        fuelScore, attendanceScore, safetyScore,
      };
      if (existing) {
        await prisma.driverScore.update({ where: { id: existing.id }, data: { ...scoreFields, month: m, year: y } });
      } else {
        await prisma.driverScore.create({ data: { driverId: driver.id, month: m, year: y, ...scoreFields } });
      }
      scores.push({ driverId: driver.id, name: `${driver.firstName} ${driver.lastName}`, month: m, year: y, ...scoreFields });
    }

    scores.sort((a, b) => b.totalScore - a.totalScore);
    return res.json({ scores, month: m, year: y });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Leaderboard
router.get('/leaderboard', async (req: AuthRequest, res: Response) => {
  try {
    const { month, year } = req.query as any;
    const m = month ? Number(month) : new Date().getMonth() + 1;
    const y = year ? Number(year) : new Date().getFullYear();
    const scores = await prisma.driverScore.findMany({
      where: { month: m, year: y },
      include: { driver: { select: { firstName: true, lastName: true } } },
      orderBy: { totalScore: 'desc' },
    });
    return res.json({ scores: scores.map((s: any, i: number) => ({
      rank: i + 1, driverId: s.driverId,
      name: `${s.driver.firstName} ${s.driver.lastName}`,
      totalScore: s.totalScore, tripCount: s.tripCount,
      tripScore: s.tripScore, shortageScore: s.shortageScore,
      cycleTimeScore: s.cycleTimeScore, fuelScore: s.fuelScore,
      attendanceScore: s.attendanceScore, safetyScore: s.safetyScore,
    })), month: m, year: y });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Driver score history
router.get('/:driverId/history', async (req: AuthRequest, res: Response) => {
  try {
    const scores = await prisma.driverScore.findMany({
      where: { driverId: req.params.driverId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 12,
    });
    return res.json({ scores });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
