import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Wonde Transport ERP...');

  // ── Users ──────────────────────────────────────────────────────────────────
  const ownerHash = await bcrypt.hash('Admin@1234', 10);
  const owner = await prisma.user.upsert({
    where: { email: 'admin@wonde.et' },
    update: {},
    create: { email: 'admin@wonde.et', password: ownerHash, name: 'System Admin', role: 'owner' },
  });
  console.log('✅ Owner user created:', owner.email);

  // ── Employees ──────────────────────────────────────────────────────────────
  const employees = await Promise.all([
    prisma.employee.upsert({ where: { empNumber: 'EMP-001' }, update: {}, create: {
      empNumber: 'EMP-001', firstName: 'Abebe', lastName: 'Kebede', role: 'driver',
      department: 'Operations', basicSalary: 8000, perDiemRate: 200, hireDate: new Date('2022-01-15'),
      contractType: 'permanent', phone: '+251911000001', status: 'active' } }),
    prisma.employee.upsert({ where: { empNumber: 'EMP-002' }, update: {}, create: {
      empNumber: 'EMP-002', firstName: 'Tadesse', lastName: 'Girma', role: 'driver',
      department: 'Operations', basicSalary: 8500, perDiemRate: 200, hireDate: new Date('2021-06-01'),
      contractType: 'permanent', phone: '+251911000002', status: 'active' } }),
    prisma.employee.upsert({ where: { empNumber: 'EMP-003' }, update: {}, create: {
      empNumber: 'EMP-003', firstName: 'Yohannes', lastName: 'Tesfaye', role: 'driver',
      department: 'Operations', basicSalary: 7800, perDiemRate: 200, hireDate: new Date('2023-03-01'),
      contractType: 'permanent', phone: '+251911000003', status: 'active' } }),
    prisma.employee.upsert({ where: { empNumber: 'EMP-004' }, update: {}, create: {
      empNumber: 'EMP-004', firstName: 'Mulugeta', lastName: 'Haile', role: 'helper',
      department: 'Operations', basicSalary: 5000, perDiemRate: 100, hireDate: new Date('2022-08-01'),
      contractType: 'contract', phone: '+251911000004', status: 'active' } }),
    prisma.employee.upsert({ where: { empNumber: 'EMP-005' }, update: {}, create: {
      empNumber: 'EMP-005', firstName: 'Dawit', lastName: 'Alemu', role: 'technical',
      department: 'Technical', basicSalary: 10000, perDiemRate: 0, hireDate: new Date('2020-11-01'),
      contractType: 'permanent', phone: '+251911000005', status: 'active' } }),
    prisma.employee.upsert({ where: { empNumber: 'EMP-006' }, update: {}, create: {
      empNumber: 'EMP-006', firstName: 'Selamawit', lastName: 'Bekele', role: 'cashier',
      department: 'Finance', basicSalary: 9000, perDiemRate: 0, hireDate: new Date('2021-02-01'),
      contractType: 'permanent', phone: '+251911000006', status: 'active' } }),
    prisma.employee.upsert({ where: { empNumber: 'EMP-007' }, update: {}, create: {
      empNumber: 'EMP-007', firstName: 'Hiwot', lastName: 'Tadesse', role: 'hr',
      department: 'HR', basicSalary: 9500, perDiemRate: 0, hireDate: new Date('2021-04-01'),
      contractType: 'permanent', phone: '+251911000007', status: 'active' } }),
    prisma.employee.upsert({ where: { empNumber: 'EMP-008' }, update: {}, create: {
      empNumber: 'EMP-008', firstName: 'Bereket', lastName: 'Solomon', role: 'store',
      department: 'Store', basicSalary: 7500, perDiemRate: 0, hireDate: new Date('2022-01-01'),
      contractType: 'permanent', phone: '+251911000008', status: 'active' } }),
  ]);
  console.log(`✅ ${employees.length} employees created`);

  // ── Create user accounts for cashier ──────────────────────────────────────
  const cashierHash = await bcrypt.hash('cashier123', 10);
  const cashierUser = await prisma.user.upsert({
    where: { email: 'cashier@wonde.et' },
    update: {},
    create: { email: 'cashier@wonde.et', password: cashierHash, name: 'Selamawit Bekele',
      role: 'cashier', employeeId: employees[5].id },
  });

  // ── Cashiers ───────────────────────────────────────────────────────────────
  const cashier1 = await prisma.cashier.upsert({
    where: { userId: cashierUser.id },
    update: {},
    create: { userId: cashierUser.id, name: 'Selamawit Bekele', floatAmount: 50000, currentBalance: 45000 },
  });
  console.log('✅ Cashier created');

  // ── Vehicles ───────────────────────────────────────────────────────────────
  const vehicles = await Promise.all([
    prisma.vehicle.upsert({ where: { plateNumber: 'AA-12345' }, update: {}, create: {
      plateNumber: 'AA-12345', category: 'cement_tanker', make: 'Isuzu', model: 'CYZ52',
      year: 2019, capacityTons: 25, purchaseCost: 3500000, usefulLifeYears: 8, residualValue: 350000,
      currentKm: 125000, status: 'active', color: 'White',
      insuranceExpiry: new Date('2025-06-30'), inspectionExpiry: new Date('2025-03-31') } }),
    prisma.vehicle.upsert({ where: { plateNumber: 'AA-23456' }, update: {}, create: {
      plateNumber: 'AA-23456', category: 'cement_tanker', make: 'Isuzu', model: 'CYZ52',
      year: 2020, capacityTons: 25, purchaseCost: 3800000, usefulLifeYears: 8, residualValue: 380000,
      currentKm: 98000, status: 'active', color: 'White',
      insuranceExpiry: new Date('2025-08-31'), inspectionExpiry: new Date('2025-05-31') } }),
    prisma.vehicle.upsert({ where: { plateNumber: 'AA-34567' }, update: {}, create: {
      plateNumber: 'AA-34567', category: 'gravel_tipper', make: 'Sino Truck', model: 'HOWO T7H',
      year: 2021, capacityTons: 30, purchaseCost: 4200000, usefulLifeYears: 8, residualValue: 420000,
      currentKm: 67000, status: 'active', color: 'Orange',
      insuranceExpiry: new Date('2025-09-30'), inspectionExpiry: new Date('2025-06-30') } }),
    prisma.vehicle.upsert({ where: { plateNumber: 'AA-45678' }, update: {}, create: {
      plateNumber: 'AA-45678', category: 'gravel_tipper', make: 'Sino Truck', model: 'HOWO T7H',
      year: 2021, capacityTons: 30, purchaseCost: 4200000, usefulLifeYears: 8, residualValue: 420000,
      currentKm: 72000, status: 'maintenance', color: 'Orange',
      insuranceExpiry: new Date('2025-09-30'), inspectionExpiry: new Date('2025-06-30') } }),
    prisma.vehicle.upsert({ where: { plateNumber: 'AA-56789' }, update: {}, create: {
      plateNumber: 'AA-56789', category: 'office_car', make: 'Toyota', model: 'Land Cruiser',
      year: 2022, capacityTons: 0, purchaseCost: 2800000, usefulLifeYears: 10, residualValue: 280000,
      currentKm: 35000, status: 'active', color: 'Silver',
      insuranceExpiry: new Date('2025-12-31'), inspectionExpiry: new Date('2025-08-31') } }),
  ]);
  console.log(`✅ ${vehicles.length} vehicles created`);

  // ── Asset Depreciation ─────────────────────────────────────────────────────
  for (const v of vehicles) {
    const exists = await prisma.assetDepreciation.findUnique({ where: { vehicleId: v.id } });
    if (!exists && v.purchaseCost > 0) {
      const monthly = (v.purchaseCost - v.residualValue) / (v.usefulLifeYears * 12);
      await prisma.assetDepreciation.create({ data: {
        vehicleId: v.id, purchaseCost: v.purchaseCost, residualValue: v.residualValue,
        usefulLifeYears: v.usefulLifeYears, method: 'straight_line',
        monthlyDepreciation: monthly, accumulatedDepr: 0, bookValue: v.purchaseCost,
        startDate: new Date('2023-01-01') } });
    }
  }
  console.log('✅ Asset depreciation records created');

  // ── Maintenance Schedules ──────────────────────────────────────────────────
  for (const v of vehicles.slice(0, 4)) {
    const schedTypes = [
      { maintenanceType: 'oil_change', intervalDays: 90, nextDue: 30 },
      { maintenanceType: 'tire_rotation', intervalDays: 180, nextDue: 60 },
      { maintenanceType: 'brake_inspection', intervalDays: 365, nextDue: 90 },
      { maintenanceType: 'annual_inspection', intervalDays: 365, nextDue: 120 },
      { maintenanceType: 'insurance', intervalDays: 365, nextDue: 180 },
    ];
    for (const s of schedTypes) {
      await prisma.maintenanceSchedule.upsert({
        where: { id: `sched-${v.id}-${s.maintenanceType}` },
        update: {},
        create: { id: `sched-${v.id}-${s.maintenanceType}`, vehicleId: v.id,
          maintenanceType: s.maintenanceType, intervalDays: s.intervalDays,
          nextDueDate: new Date(Date.now() + s.nextDue * 86400000), status: 'upcoming' },
      });
    }
  }
  console.log('✅ Maintenance schedules created');

  // ── Customers ──────────────────────────────────────────────────────────────
  const customers = await Promise.all([
    prisma.customer.upsert({ where: { id: 'cust-001' }, update: {}, create: {
      id: 'cust-001', companyName: 'Derba Cement PLC', contactName: 'Alemu Desta',
      phone: '+251911100001', email: 'logistics@derba.et', address: 'Addis Ababa',
      paymentType: 'monthly', creditLimit: 500000, creditDays: 45, status: 'active' } }),
    prisma.customer.upsert({ where: { id: 'cust-002' }, update: {}, create: {
      id: 'cust-002', companyName: 'Mugher Cement Factory', contactName: 'Tigist Haile',
      phone: '+251911100002', email: 'orders@mugher.et', address: 'Muger',
      paymentType: 'credit', creditLimit: 300000, creditDays: 30, status: 'active' } }),
    prisma.customer.upsert({ where: { id: 'cust-003' }, update: {}, create: {
      id: 'cust-003', companyName: 'Ethiopia Construction', contactName: 'Kebede Worku',
      phone: '+251911100003', email: 'supply@ethcon.et', address: 'Addis Ababa',
      paymentType: 'cash', creditLimit: 0, creditDays: 0, status: 'active' } }),
  ]);
  console.log(`✅ ${customers.length} customers created`);

  // ── Suppliers ──────────────────────────────────────────────────────────────
  const suppliers = await Promise.all([
    prisma.supplier.upsert({ where: { id: 'sup-001' }, update: {}, create: {
      id: 'sup-001', name: 'Addis Spare Parts', contactName: 'Mohammed Ali',
      phone: '+251911200001', email: 'sales@addisspare.et', address: 'Mercato, Addis Ababa' } }),
    prisma.supplier.upsert({ where: { id: 'sup-002' }, update: {}, create: {
      id: 'sup-002', name: 'Ethiopian Auto Parts', contactName: 'Berhane Tekle',
      phone: '+251911200002', email: 'info@etauto.et', address: 'Piassa, Addis Ababa' } }),
    prisma.supplier.upsert({ where: { id: 'sup-003' }, update: {}, create: {
      id: 'sup-003', name: 'Horn Tyres PLC', contactName: 'Sara Abebe',
      phone: '+251911200003', email: 'sales@horntyre.et', address: 'Bole, Addis Ababa' } }),
  ]);
  console.log(`✅ ${suppliers.length} suppliers created`);

  // ── Inventory ──────────────────────────────────────────────────────────────
  const inventory = await Promise.all([
    prisma.inventory.upsert({ where: { partNumber: 'OIL-15W40' }, update: {}, create: {
      partName: 'Engine Oil 15W40', partNumber: 'OIL-15W40', category: 'lubricant',
      unit: 'liter', quantityInStock: 200, minimumStock: 50, unitCost: 95, totalValue: 19000 } }),
    prisma.inventory.upsert({ where: { partNumber: 'FLT-OIL-001' }, update: {}, create: {
      partName: 'Oil Filter', partNumber: 'FLT-OIL-001', category: 'spare_part',
      unit: 'pcs', quantityInStock: 25, minimumStock: 10, unitCost: 450, totalValue: 11250 } }),
    prisma.inventory.upsert({ where: { partNumber: 'FLT-AIR-001' }, update: {}, create: {
      partName: 'Air Filter', partNumber: 'FLT-AIR-001', category: 'spare_part',
      unit: 'pcs', quantityInStock: 8, minimumStock: 10, unitCost: 850, totalValue: 6800 } }),
    prisma.inventory.upsert({ where: { partNumber: 'TIRE-11R22' }, update: {}, create: {
      partName: 'Truck Tire 11R22.5', partNumber: 'TIRE-11R22', category: 'tire',
      unit: 'pcs', quantityInStock: 12, minimumStock: 8, unitCost: 8500, totalValue: 102000 } }),
    prisma.inventory.upsert({ where: { partNumber: 'BRAKE-PAD-001' }, update: {}, create: {
      partName: 'Brake Pad Set', partNumber: 'BRAKE-PAD-001', category: 'spare_part',
      unit: 'set', quantityInStock: 6, minimumStock: 4, unitCost: 2200, totalValue: 13200 } }),
    prisma.inventory.upsert({ where: { partNumber: 'GRSE-001' }, update: {}, create: {
      partName: 'Grease Lithium', partNumber: 'GRSE-001', category: 'lubricant',
      unit: 'kg', quantityInStock: 30, minimumStock: 10, unitCost: 180, totalValue: 5400 } }),
  ]);
  console.log(`✅ ${inventory.length} inventory items created`);

  // ── Rental Owners ──────────────────────────────────────────────────────────
  const rentalOwner = await prisma.rentalOwner.upsert({
    where: { id: 'rent-own-001' },
    update: {},
    create: { id: 'rent-own-001', name: 'Girma Transport', phone: '+251911300001',
      email: 'girma@transport.et', paymentTerms: 'credit', currentBalance: -15000 },
  });

  await prisma.rentalVehicle.upsert({
    where: { plateNumber: 'AA-99001' },
    update: {},
    create: { ownerId: rentalOwner.id, plateNumber: 'AA-99001',
      vehicleType: 'gravel_tipper', capacityTons: 28, ratePerTon: 85, paymentTerms: 'credit' },
  });
  console.log('✅ Rental owner and vehicle created');

  // ── Garages ────────────────────────────────────────────────────────────────
  await Promise.all([
    prisma.garage.upsert({ where: { id: 'garage-001' }, update: {}, create: {
      id: 'garage-001', name: 'Internal Workshop', isInternal: true, address: 'Main Depot' } }),
    prisma.garage.upsert({ where: { id: 'garage-002' }, update: {}, create: {
      id: 'garage-002', name: 'Selam Auto Service', isInternal: false,
      phone: '+251911400001', address: 'Akaki, Addis Ababa', speciality: 'Heavy trucks' } }),
  ]);
  console.log('✅ Garages created');

  // ── Sample Order ───────────────────────────────────────────────────────────
  const sampleOrder = await prisma.customerOrder.upsert({
    where: { orderNumber: 'ORD-2024-000001' },
    update: {},
    create: {
      orderNumber: 'ORD-2024-000001', customerId: customers[0].id,
      orderType: 'cement', quantity: 150,
      pickupLocation: 'Derba Cement Plant, Muger', deliveryLocation: 'Addis Ababa Depot, Site A',
      paymentType: 'monthly', ratePerTon: 120, totalAmount: 18000, status: 'approved',
    },
  });
  console.log('✅ Sample order created');

  // ── Sample Trips ───────────────────────────────────────────────────────────
  const sampleTrip = await prisma.trip.upsert({
    where: { tripNumber: 'TRP-2024-000001' },
    update: {},
    create: {
      tripNumber: 'TRP-2024-000001', orderId: sampleOrder.id,
      vehicleId: vehicles[0].id, driverId: employees[0].id,
      customerId: customers[0].id, tripDate: new Date(),
      orderType: 'cement', pickupLocation: 'Derba Cement Plant',
      deliveryLocation: 'Addis Ababa Site A', plannedQuantityTons: 25,
      loadedQuantityTons: 25, ratePerTon: 120, status: 'completed',
      deliveredQuantityTons: 24.8, shortage: 0.2,
      revenue: 24.8 * 120, shortageDeduction: 0.2 * 120,
    },
  });
  console.log('✅ Sample trip created');

  // ── Sample Fuel Log ────────────────────────────────────────────────────────
  await prisma.fuelLog.create({ data: {
    vehicleId: vehicles[0].id, tripId: sampleTrip.id,
    date: new Date(), liters: 85, costPerLiter: 42.5, totalCost: 3612.5,
    odometerKm: 125100, fuelStation: 'NOC Fuel Station, Muger',
    cashierId: cashier1.id,
  } });
  console.log('✅ Sample fuel log created');

  console.log('\n🎉 Seed complete!');
  console.log('─────────────────────────────────');
  console.log('Login: admin@wonde.et / Admin@1234');
  console.log('─────────────────────────────────');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
