const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const vehicles = await p.vehicle.findMany({
      select: { plateNumber: true, insuranceExpiry: true, inspectionExpiry: true, permitExpiry: true, status: true },
      take: 5
    });
    console.log('Vehicles with expiry dates:');
    vehicles.forEach(v => {
      console.log(`  ${v.plateNumber}: insurance=${v.insuranceExpiry}, inspection=${v.inspectionExpiry}, permit=${v.permitExpiry}, status=${v.status}`);
    });

    // Check fleet-board endpoint response shape
    const all = await p.vehicle.findMany({ where: { status: { not: 'inactive' } }, select: { plateNumber: true, operationalStatus: true, complianceLocked: true } });
    console.log('\nAll vehicles operationalStatus:');
    all.forEach(v => console.log(`  ${v.plateNumber}: opStatus=${v.operationalStatus}, locked=${v.complianceLocked}`));
  } catch (e) {
    console.log('Error:', e.message);
  }
  await p.$disconnect();
})();
