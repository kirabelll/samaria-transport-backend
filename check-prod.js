const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const v = await p.vehicle.findFirst({ select: { id: true, plateNumber: true, operationalStatus: true, complianceLocked: true, status: true } });
    console.log('Sample vehicle:', JSON.stringify(v));
    const c = await p.vehicle.count();
    console.log('Total vehicles:', c);
  } catch (e) {
    console.log('Error:', e.message);
  }
  await p.$disconnect();
})();
