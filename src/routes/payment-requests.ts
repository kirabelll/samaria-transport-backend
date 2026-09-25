import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import prisma from '../utils/prisma';
const router = Router();
router.use(authenticate);

// GET /stats - Summary stats
router.get('/stats', async (req: AuthRequest, res: Response) => {
  try {
    const [pending, approved, paid] = await Promise.all([
      prisma.paymentRequest.aggregate({ where: { status: 'submitted' }, _sum: { amount: true }, _count: true }),
      prisma.paymentRequest.aggregate({ where: { status: 'approved' }, _sum: { amount: true }, _count: true }),
      prisma.paymentRequest.aggregate({ where: { status: 'paid' }, _sum: { amount: true, paidAmount: true }, _count: true }),
    ]);
    return res.json({
      pending: { count: pending._count, totalAmount: pending._sum.amount || 0 },
      approved: { count: approved._count, totalAmount: approved._sum.amount || 0 },
      paid: { count: paid._count, totalAmount: paid._sum.paidAmount || 0 },
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// GET /source-data - List candidate records to populate payment request based on selected paymentType
router.get('/source-data', async (req: AuthRequest, res: Response) => {
  try {
    const type = String(req.query.type || '').trim().toLowerCase();
    const q = String(req.query.search || req.query.q || '').trim().toLowerCase();
    let results: any[] = [];

    if (type === 'advance') {
      // 1. Pending/Approved Driver Advances
      const advances = await prisma.driverAdvance.findMany({
        take: 25,
        orderBy: { requestedAt: 'desc' },
        include: {
          driver: true,
          trip: { include: { vehicle: true } },
        },
      });
      advances.forEach(adv => {
        const driverName = adv.driver ? `${adv.driver.firstName} ${adv.driver.lastName}`.trim() : 'Unknown Driver';
        const plate = adv.trip?.vehicle?.plateNumber || '';
        const tripNum = adv.trip?.tripNumber || '';
        results.push({
          id: `adv-${adv.id}`,
          title: `Advance Req: ${driverName} (${adv.amount ? `ETB ${adv.amount.toLocaleString()}` : 'ETB 0'})`,
          subtitle: `Status: ${adv.status} · ${tripNum ? `Trip ${tripNum}` : 'General'}${plate ? ` · Plate ${plate}` : ''}${adv.reason ? ` · ${adv.reason}` : ''}`,
          badge: `Advance (${adv.status})`,
          referenceType: 'trip',
          referenceId: tripNum || `ADV-${adv.id.slice(0, 8).toUpperCase()}`,
          payee: driverName,
          amount: adv.amount || 0,
          department: 'fleet',
          description: `Driver advance for ${driverName}${tripNum ? ` - Trip ${tripNum}` : ''}${adv.reason ? ` (${adv.reason})` : ''}`,
          vehicleId: adv.trip?.vehicleId || null,
          payeeBank: adv.driver?.bankAccount ? 'CBE' : null,
          payeeAccountHolder: driverName,
          payeeAccountNumber: adv.driver?.bankAccount || null,
          paymentMethod: adv.driver?.bankAccount ? 'bank_transfer' : 'cash',
        });
      });

      // 2. Active Trips needing advance
      const trips = await prisma.trip.findMany({
        where: {
          status: { in: ['planned', 'dispatched', 'loading', 'in_transit', 'delivering'] },
        },
        take: 25,
        orderBy: { createdAt: 'desc' },
        include: { driver: true, vehicle: true },
      });
      trips.forEach(t => {
        const driverName = t.driver ? `${t.driver.firstName} ${t.driver.lastName}`.trim() : 'Assigned Driver';
        results.push({
          id: `trip-adv-${t.id}`,
          title: `Trip ${t.tripNumber}: ${t.pickupLocation} → ${t.deliveryLocation}`,
          subtitle: `Driver: ${driverName} · Vehicle: ${t.vehicle?.plateNumber || '-'} · Advance Given: ETB ${t.driverAdvanceGiven || 0}`,
          badge: `Trip (${t.status})`,
          referenceType: 'trip',
          referenceId: t.tripNumber,
          payee: driverName,
          amount: t.driverAdvanceGiven || 2500,
          department: 'fleet',
          description: `Trip advance for driver ${driverName} on Trip ${t.tripNumber}`,
          vehicleId: t.vehicleId || null,
          payeeBank: t.driver?.bankAccount ? 'CBE' : null,
          payeeAccountHolder: driverName,
          payeeAccountNumber: t.driver?.bankAccount || null,
          paymentMethod: t.driver?.bankAccount ? 'bank_transfer' : 'cash',
        });
      });

      // 3. Active Drivers
      const drivers = await prisma.employee.findMany({
        where: { role: 'driver', status: 'active' },
        take: 20,
        orderBy: { firstName: 'asc' },
      });
      drivers.forEach(d => {
        const driverName = `${d.firstName} ${d.lastName}`.trim();
        results.push({
          id: `emp-driver-${d.id}`,
          title: `Driver: ${driverName} (${d.empNumber})`,
          subtitle: `Phone: ${d.phone || '-'} · Dept: ${d.department || 'fleet'} · Bank: ${d.bankAccount || 'None'}`,
          badge: 'Driver',
          referenceType: 'trip',
          referenceId: `DRV-${d.empNumber}`,
          payee: driverName,
          amount: 2000,
          department: 'fleet',
          description: `Advance payment for driver ${driverName} (${d.empNumber})`,
          vehicleId: null,
          payeeBank: d.bankAccount ? 'CBE' : null,
          payeeAccountHolder: driverName,
          payeeAccountNumber: d.bankAccount || null,
          paymentMethod: d.bankAccount ? 'bank_transfer' : 'cash',
        });
      });

    } else if (type === 'fuel') {
      // 1. Recent Fuel Logs
      const fuelLogs = await prisma.fuelLog.findMany({
        take: 30,
        orderBy: { date: 'desc' },
        include: { vehicle: true, driver: true, trip: true },
      });
      fuelLogs.forEach(fl => {
        const plate = fl.vehicle?.plateNumber || 'Vehicle';
        const driverName = fl.driver ? `${fl.driver.firstName} ${fl.driver.lastName}`.trim() : '';
        const station = fl.fuelStation || 'Fuel Station';
        results.push({
          id: `fuel-${fl.id}`,
          title: `Fuel: ${plate} · ${fl.liters || 0}L at ${station}`,
          subtitle: `Cost: ETB ${fl.totalCost?.toLocaleString() || 0} (${fl.costPerLiter || 0}/L)${driverName ? ` · Driver: ${driverName}` : ''}${fl.trip?.tripNumber ? ` · Trip ${fl.trip.tripNumber}` : ''}`,
          badge: 'Fuel Log',
          referenceType: 'trip',
          referenceId: fl.trip?.tripNumber || `FUEL-${fl.id.slice(0, 8).toUpperCase()}`,
          payee: station,
          amount: fl.totalCost || 0,
          department: 'fleet',
          description: `Fuel purchase for vehicle ${plate} (${fl.liters || 0}L @ ETB ${fl.costPerLiter || 0} at ${station})`,
          vehicleId: fl.vehicleId || null,
          payeeBank: null,
          payeeAccountHolder: station,
          payeeAccountNumber: null,
          paymentMethod: 'cash',
        });
      });

      // 2. Active Trips for Fuel Coupon/Payment
      const activeTrips = await prisma.trip.findMany({
        where: { status: { in: ['planned', 'dispatched', 'loading', 'in_transit'] } },
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: { vehicle: true, driver: true },
      });
      activeTrips.forEach(t => {
        const plate = t.vehicle?.plateNumber || '-';
        results.push({
          id: `trip-fuel-${t.id}`,
          title: `Fuel for Trip ${t.tripNumber} (${plate})`,
          subtitle: `${t.pickupLocation} → ${t.deliveryLocation} · Est. Fuel: ETB ${t.fuelCost || 0}`,
          badge: `Trip (${t.status})`,
          referenceType: 'trip',
          referenceId: t.tripNumber,
          payee: 'National Oil / Total Station',
          amount: t.fuelCost || 5000,
          department: 'fleet',
          description: `Fuel disbursement for Trip ${t.tripNumber} (${plate})`,
          vehicleId: t.vehicleId || null,
          paymentMethod: 'cash',
        });
      });

      // 3. Fuel Suppliers
      const fuelSuppliers = await prisma.supplier.findMany({
        where: { suppliedCategory: 'fuel', status: 'active' },
        take: 15,
      });
      fuelSuppliers.forEach(s => {
        results.push({
          id: `supp-fuel-${s.id}`,
          title: `Fuel Supplier: ${s.name}`,
          subtitle: `Phone: ${s.phone || '-'} · Balance: ETB ${s.currentBalance || 0}`,
          badge: 'Supplier',
          referenceType: 'po',
          referenceId: `SUPP-${s.id.slice(0, 6).toUpperCase()}`,
          payee: s.name,
          amount: s.currentBalance > 0 ? s.currentBalance : 10000,
          department: 'fleet',
          description: `Fuel replenishment / bulk payment to ${s.name}`,
          vehicleId: null,
          payeeAccountHolder: s.name,
          paymentMethod: 'bank_transfer',
        });
      });

    } else if (type === 'garage') {
      // 1. Work Orders
      const wos = await prisma.workOrder.findMany({
        take: 35,
        orderBy: { createdAt: 'desc' },
        include: {
          vehicle: true,
          garage: true,
          technician: true,
        },
      });
      wos.forEach(wo => {
        const plate = wo.vehicle?.plateNumber || 'Vehicle';
        const garageName = wo.garage?.name || (wo.garageType === 'internal' ? 'Internal Workshop' : 'External Garage');
        const cost = wo.totalCost || ((wo.laborCost || 0) + (wo.partsCost || 0)) || 0;
        results.push({
          id: `wo-${wo.id}`,
          title: `WO ${wo.workOrderNumber}: ${plate} (${garageName})`,
          subtitle: `Status: ${wo.status} · Type: ${wo.type} · Est. Cost: ETB ${cost.toLocaleString()} · ${wo.description}`,
          badge: `WO (${wo.status})`,
          referenceType: 'work_order',
          referenceId: wo.workOrderNumber,
          payee: garageName,
          amount: cost,
          department: 'workshop',
          description: `Garage repair payment for WO ${wo.workOrderNumber} (${plate}): ${wo.description}`,
          vehicleId: wo.vehicleId || null,
          payeeBank: null,
          payeeAccountHolder: garageName,
          payeeAccountNumber: null,
          paymentMethod: 'cash',
        });
      });

      // 2. Garages
      const garages = await prisma.garage.findMany({ take: 20 });
      garages.forEach(g => {
        results.push({
          id: `garage-${g.id}`,
          title: `Garage: ${g.name}`,
          subtitle: `Phone: ${g.phone || '-'} · Address: ${g.address || '-'}`,
          badge: 'Garage',
          referenceType: 'work_order',
          referenceId: `GAR-${g.id.slice(0, 6).toUpperCase()}`,
          payee: g.name,
          amount: 5000,
          department: 'workshop',
          description: `Maintenance / repair services at ${g.name}`,
          vehicleId: null,
          payeeAccountHolder: g.name,
          paymentMethod: 'bank_transfer',
        });
      });

    } else if (type === 'spare_part') {
      // 1. Spare Part Requests
      const sprs = await prisma.sparePartRequest.findMany({
        take: 30,
        orderBy: { createdAt: 'desc' },
        include: {
          workOrder: { include: { vehicle: true } },
          trip: { include: { vehicle: true } },
          inventory: true,
        },
      });
      sprs.forEach(spr => {
        const plate = spr.workOrder?.vehicle?.plateNumber || spr.trip?.vehicle?.plateNumber || '';
        const woNum = spr.workOrder?.workOrderNumber || '';
        results.push({
          id: `spr-${spr.id}`,
          title: `Spare Part: ${spr.partName} (${spr.quantityNeeded} pcs)`,
          subtitle: `Status: ${spr.status} · Unit: ETB ${spr.unitCost || 0} · Total: ETB ${spr.totalCost || 0}${plate ? ` · Plate ${plate}` : ''}`,
          badge: `Part Req (${spr.status})`,
          referenceType: woNum ? 'work_order' : 'po',
          referenceId: woNum || `SPR-${spr.id.slice(0, 8).toUpperCase()}`,
          payee: 'Spare Parts Supplier',
          amount: spr.totalCost || ((spr.unitCost || 0) * spr.quantityNeeded) || 0,
          department: 'store',
          description: `Purchase of ${spr.quantityNeeded}x ${spr.partName}${plate ? ` for vehicle ${plate}` : ''}${woNum ? ` (WO: ${woNum})` : ''}`,
          vehicleId: spr.workOrder?.vehicleId || spr.trip?.vehicleId || null,
          paymentMethod: 'cash',
        });
      });

      // 2. Purchase Requests with category spare_parts
      const prs = await prisma.purchaseRequest.findMany({
        where: { category: { in: ['spare_parts', 'tyres', 'tools'] } },
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: { lines: true, purchaseOrder: true },
      });
      prs.forEach(pr => {
        const lineCount = pr.lines?.length || 0;
        const totalEst = pr.lines?.reduce((sum, l) => sum + ((l.estimatedCost || 0) * (l.quantityNeeded || 1)), 0) || 0;
        results.push({
          id: `pr-parts-${pr.id}`,
          title: `PR ${pr.requestNumber}: ${pr.category} (${lineCount} items)`,
          subtitle: `Status: ${pr.status} · Est. Total: ETB ${totalEst.toLocaleString()}${pr.purchaseOrder ? ` · PO ${pr.purchaseOrder.poNumber}` : ''}`,
          badge: `PR (${pr.status})`,
          referenceType: pr.purchaseOrder ? 'po' : 'po',
          referenceId: pr.purchaseOrder?.poNumber || pr.requestNumber,
          payee: 'Spare Parts Supplier',
          amount: pr.purchaseOrder?.totalAmount || totalEst || 0,
          department: pr.department || 'store',
          description: `Spare parts purchase for PR ${pr.requestNumber} (${lineCount} items)`,
          vehicleId: null,
          paymentMethod: 'bank_transfer',
        });
      });

    } else if (type === 'salary') {
      // 1. Recent Payroll Records
      const payrolls = await prisma.payroll.findMany({
        take: 30,
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: { employee: true },
      });
      payrolls.forEach(p => {
        const empName = p.employee ? `${p.employee.firstName} ${p.employee.lastName}`.trim() : 'Employee';
        const refId = `PAYROLL-${p.year}-${String(p.month).padStart(2, '0')}-${p.employee?.empNumber || 'EMP'}`;
        results.push({
          id: `payroll-${p.id}`,
          title: `Payroll ${p.month}/${p.year}: ${empName} (${p.employee?.empNumber || '-'})`,
          subtitle: `Dept: ${p.employee?.department || '-'} · Net Salary: ETB ${(p.netSalary || p.totalEarnings || 0).toLocaleString()} · Status: ${p.status}`,
          badge: `Payroll ${p.month}/${p.year}`,
          referenceType: 'payroll',
          referenceId: refId,
          payee: empName,
          amount: p.netSalary || p.totalEarnings || p.basicSalary || 0,
          department: p.employee?.department || 'hr',
          description: `Salary payment for ${empName} (${p.employee?.role || 'Staff'}) for Month ${p.month}/${p.year}`,
          vehicleId: null,
          payeeBank: p.employee?.bankAccount ? 'CBE' : null,
          payeeAccountHolder: empName,
          payeeAccountNumber: p.employee?.bankAccount || null,
          paymentMethod: p.employee?.bankAccount ? 'bank_transfer' : 'cash',
        });
      });

      // 2. Active Employees
      const employees = await prisma.employee.findMany({
        where: { status: 'active' },
        take: 40,
        orderBy: { firstName: 'asc' },
      });
      employees.forEach(e => {
        const empName = `${e.firstName} ${e.lastName}`.trim();
        results.push({
          id: `emp-salary-${e.id}`,
          title: `Employee: ${empName} (${e.empNumber})`,
          subtitle: `Role: ${e.role} · Dept: ${e.department} · Basic Salary: ETB ${e.basicSalary?.toLocaleString() || 0} · Bank: ${e.bankAccount || 'None'}`,
          badge: `${e.role} (${e.department})`,
          referenceType: 'payroll',
          referenceId: `SALARY-${e.empNumber}`,
          payee: empName,
          amount: e.basicSalary || 0,
          department: e.department || 'hr',
          description: `Salary payout for ${empName} (${e.empNumber} - ${e.role})`,
          vehicleId: null,
          payeeBank: e.bankAccount ? 'CBE' : null,
          payeeAccountHolder: empName,
          payeeAccountNumber: e.bankAccount || null,
          paymentMethod: e.bankAccount ? 'bank_transfer' : 'cash',
        });
      });

    } else if (type === 'rental') {
      // 1. Rental Trips
      const rentalTrips = await prisma.rentalTrip.findMany({
        take: 25,
        orderBy: { createdAt: 'desc' },
        include: {
          rentalVehicle: { include: { owner: true } },
        },
      });
      rentalTrips.forEach(rt => {
        const owner = rt.rentalVehicle?.owner;
        const ownerName = owner?.name || 'Rental Owner';
        const plate = rt.rentalVehicle?.plateNumber || 'Rental Truck';
        results.push({
          id: `rtrip-${rt.id}`,
          title: `Rental Trip: ${plate} · ${rt.pickupLocation} → ${rt.deliveryLocation}`,
          subtitle: `Owner: ${ownerName} · Payable: ETB ${rt.rentalPayable?.toLocaleString() || 0} · Qty: ${rt.quantityTons} Tons`,
          badge: 'Rental Trip',
          referenceType: 'trip',
          referenceId: `RTRP-${rt.id.slice(0, 8).toUpperCase()}`,
          payee: ownerName,
          amount: rt.rentalPayable || 0,
          department: 'fleet',
          description: `Rental payment for trip ${rt.pickupLocation} to ${rt.deliveryLocation} (${plate}, Owner: ${ownerName})`,
          vehicleId: null,
          payeeBank: owner?.bankName || null,
          payeeAccountHolder: owner?.bankAccountHolder || ownerName,
          payeeAccountNumber: owner?.bankAccountNumber || owner?.bankAccount || null,
          paymentMethod: owner?.paymentMethod || (owner?.bankAccount ? 'bank_transfer' : 'cash'),
        });
      });

      // 2. Rental Owners
      const rentalOwners = await prisma.rentalOwner.findMany({
        take: 30,
        include: { vehicles: true },
      });
      rentalOwners.forEach(ro => {
        const plates = ro.vehicles?.map(v => v.plateNumber).join(', ') || 'No vehicles';
        results.push({
          id: `rowner-${ro.id}`,
          title: `Rental Owner: ${ro.name}`,
          subtitle: `Vehicles: ${plates} · Phone: ${ro.phone || '-'} · Balance: ETB ${ro.currentBalance?.toLocaleString() || 0}`,
          badge: 'Rental Owner',
          referenceType: 'trip',
          referenceId: `ROWNER-${ro.id.slice(0, 6).toUpperCase()}`,
          payee: ro.name,
          amount: ro.currentBalance > 0 ? ro.currentBalance : 15000,
          department: 'fleet',
          description: `Rental payout to owner ${ro.name} for vehicle services`,
          vehicleId: null,
          payeeBank: ro.bankName || null,
          payeeAccountHolder: ro.bankAccountHolder || ro.name,
          payeeAccountNumber: ro.bankAccountNumber || ro.bankAccount || null,
          paymentMethod: ro.paymentMethod || 'bank_transfer',
        });
      });

    } else if (type === 'po_payment') {
      // Purchase Orders
      const pos = await prisma.purchaseOrder.findMany({
        take: 35,
        orderBy: { createdAt: 'desc' },
        include: { supplier: true, purchaseRequest: true },
      });
      pos.forEach(po => {
        const suppName = po.supplier?.name || 'Supplier';
        results.push({
          id: `po-${po.id}`,
          title: `PO ${po.poNumber}: ${suppName}`,
          subtitle: `Total: ETB ${po.totalAmount?.toLocaleString() || 0} · Status: ${po.status} · Mode: ${po.paymentMode}`,
          badge: `PO (${po.status})`,
          referenceType: 'po',
          referenceId: po.poNumber,
          payee: suppName,
          amount: po.totalAmount || 0,
          department: po.purchaseRequest?.department || 'store',
          description: `Payment for Purchase Order ${po.poNumber} (${suppName})`,
          vehicleId: null,
          payeeBank: null,
          payeeAccountHolder: suppName,
          payeeAccountNumber: null,
          paymentMethod: po.paymentMode === 'bank_transfer' ? 'bank_transfer' : (po.paymentMode === 'cash' ? 'cash' : 'bank_transfer'),
        });
      });

    } else if (type === 'settlement') {
      // 1. Customer Settlements
      const settlements = await prisma.settlement.findMany({
        take: 30,
        orderBy: { createdAt: 'desc' },
        include: {
          order: { include: { customer: true } },
        },
      });
      settlements.forEach(s => {
        const custName = s.order?.customer?.companyName || s.order?.customer?.contactName || 'Customer';
        const net = s.netAmount || s.finalCollectibleAmount || 0;
        results.push({
          id: `stl-${s.id}`,
          title: `Settlement ${s.settlementNumber}: ${custName}`,
          subtitle: `Net: ETB ${net.toLocaleString()} · Gross: ETB ${(s.grossAmount || 0).toLocaleString()} · Status: ${s.status}`,
          badge: `Settlement (${s.status})`,
          referenceType: 'settlement',
          referenceId: s.settlementNumber,
          payee: custName,
          amount: net,
          department: 'admin',
          description: `Settlement payout/adjustment for ${s.settlementNumber} (${custName})`,
          vehicleId: null,
          payeeAccountHolder: custName,
          paymentMethod: 'bank_transfer',
        });
      });

      // 2. Revenue Share Settlements
      try {
        const rsSettlements = await (prisma as any).revenueShareSettlement.findMany({
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: { contract: true },
        });
        rsSettlements.forEach((rs: any) => {
          const plate = rs.contract?.powerVehiclePlate || '';
          results.push({
            id: `rs-stl-${rs.id}`,
            title: `RevShare STL ${rs.settlementNumber} (${rs.month}/${rs.year})`,
            subtitle: `Plate: ${plate} · Owner Payable: ETB ${(rs.ownerPayable || 0).toLocaleString()} · Status: ${rs.status}`,
            badge: `RevShare (${rs.status})`,
            referenceType: 'settlement',
            referenceId: rs.settlementNumber,
            payee: `Power Unit Owner (${plate})`,
            amount: rs.ownerPayable || 0,
            department: 'admin',
            description: `Revenue sharing settlement payout for ${rs.settlementNumber} (Period: ${rs.month}/${rs.year})`,
            vehicleId: null,
            paymentMethod: 'bank_transfer',
          });
        });
      } catch {}

    } else {
      // 'other' or default: fetch cross-module candidate records
      const [trips, wos, pos, emps] = await Promise.all([
        prisma.trip.findMany({ take: 10, orderBy: { createdAt: 'desc' }, include: { driver: true, vehicle: true } }),
        prisma.workOrder.findMany({ take: 10, orderBy: { createdAt: 'desc' }, include: { vehicle: true, garage: true } }),
        prisma.purchaseOrder.findMany({ take: 10, orderBy: { createdAt: 'desc' }, include: { supplier: true } }),
        prisma.employee.findMany({ where: { status: 'active' }, take: 10 }),
      ]);

      trips.forEach(t => {
        const driver = t.driver ? `${t.driver.firstName} ${t.driver.lastName}`.trim() : 'Driver';
        results.push({
          id: `gen-trip-${t.id}`,
          title: `Trip ${t.tripNumber} (${t.vehicle?.plateNumber || '-'})`,
          subtitle: `${t.pickupLocation} → ${t.deliveryLocation} · Driver: ${driver}`,
          badge: 'Trip',
          referenceType: 'trip',
          referenceId: t.tripNumber,
          payee: driver,
          amount: 3000,
          department: 'fleet',
          description: `Payment for Trip ${t.tripNumber}`,
          vehicleId: t.vehicleId || null,
        });
      });

      wos.forEach(w => {
        const garageName = w.garage?.name || 'Workshop';
        results.push({
          id: `gen-wo-${w.id}`,
          title: `WO ${w.workOrderNumber} (${w.vehicle?.plateNumber || '-'})`,
          subtitle: `${garageName} · ${w.description}`,
          badge: 'Work Order',
          referenceType: 'work_order',
          referenceId: w.workOrderNumber,
          payee: garageName,
          amount: w.totalCost || 4000,
          department: 'workshop',
          description: `Work order repair: ${w.workOrderNumber}`,
          vehicleId: w.vehicleId || null,
        });
      });

      pos.forEach(p => {
        results.push({
          id: `gen-po-${p.id}`,
          title: `PO ${p.poNumber} (${p.supplier?.name || 'Supplier'})`,
          subtitle: `Total: ETB ${p.totalAmount?.toLocaleString() || 0}`,
          badge: 'PO',
          referenceType: 'po',
          referenceId: p.poNumber,
          payee: p.supplier?.name || '',
          amount: p.totalAmount || 0,
          department: 'store',
          description: `Purchase order payment: ${p.poNumber}`,
        });
      });

      emps.forEach(e => {
        const name = `${e.firstName} ${e.lastName}`.trim();
        results.push({
          id: `gen-emp-${e.id}`,
          title: `Employee: ${name} (${e.empNumber})`,
          subtitle: `Dept: ${e.department} · Role: ${e.role}`,
          badge: 'Staff',
          referenceType: 'payroll',
          referenceId: `EMP-${e.empNumber}`,
          payee: name,
          amount: e.basicSalary || 0,
          department: e.department || 'office',
          description: `Payment for employee ${name}`,
          payeeAccountNumber: e.bankAccount || null,
        });
      });
    }

    // Apply search filter if query is provided
    if (q) {
      results = results.filter(item =>
        (item.title && item.title.toLowerCase().includes(q)) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        (item.payee && item.payee.toLowerCase().includes(q)) ||
        (item.referenceId && item.referenceId.toLowerCase().includes(q)) ||
        (item.badge && item.badge.toLowerCase().includes(q))
      );
    }

    return res.json({ items: results });
  } catch (e: any) {
    console.error('Error fetching source data for payment request:', e);
    return res.status(500).json({ error: e.message });
  }
});

// GET / - List payment requests with filters
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { status, department, referenceType, page = '1', limit = '20' } = req.query as any;
    const where: any = {};
    if (status) where.status = status;
    if (department) where.department = department;
    if (referenceType) where.referenceType = referenceType;
    const skip = (Number(page) - 1) * Number(limit);
    const [requests, total] = await Promise.all([
      prisma.paymentRequest.findMany({ where, skip, take: Number(limit), orderBy: { createdAt: 'desc' } }),
      prisma.paymentRequest.count({ where }),
    ]);
    return res.json({ requests, total });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// POST / - Create payment request (always starts as draft)
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      paymentType, payee, amount, description, referenceType, referenceId,
      department, dueDate, supportingDoc,
      payeeBank, payeeAccountHolder, payeeAccountNumber, paymentMethod, vehicleId,
    } = req.body;
    if (!paymentType || !payee || !amount || !description || !referenceType || !referenceId) {
      return res.status(400).json({ error: 'paymentType, payee, amount, description, referenceType, referenceId required' });
    }
    const validRefTypes = ['trip', 'work_order', 'po', 'payroll', 'settlement'];
    if (!validRefTypes.includes(referenceType)) {
      return res.status(400).json({ error: `referenceType must be one of: ${validRefTypes.join(', ')}` });
    }

    const year = new Date().getFullYear();
    const lastReq = await prisma.paymentRequest.findFirst({
      where: { requestNumber: { startsWith: `PAY-${year}-` } },
      orderBy: { requestNumber: 'desc' },
    });
    let seq = 1;
    if (lastReq) {
      const lastSeq = parseInt(lastReq.requestNumber.split('-')[2], 10);
      if (!isNaN(lastSeq)) seq = lastSeq + 1;
    }
    const requestNumber = `PAY-${year}-${String(seq).padStart(6, '0')}`;

    const request = await prisma.paymentRequest.create({
      data: {
        requestNumber,
        paymentType, payee,
        amount: Number(amount),
        description, referenceType, referenceId,
        department: department || null,
        dueDate: dueDate ? new Date(dueDate) : null,
        supportingDoc: supportingDoc || null,
        status: 'draft',
        requestedById: req.user?.id || null,
        payeeBank: payeeBank || null,
        payeeAccountHolder: payeeAccountHolder || null,
        payeeAccountNumber: payeeAccountNumber || null,
        paymentMethod: paymentMethod || null,
        vehicleId: vehicleId || null,
      } as any,
    });
    return res.status(201).json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id - Edit a draft payment request (creator only, draft only)
router.put('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft payment requests can be edited' });
    }
    if (existing.requestedById && existing.requestedById !== req.user?.id
        && req.user?.role !== 'owner' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only the creator or an admin can edit this draft' });
    }
    const {
      paymentType, payee, amount, description, referenceType, referenceId,
      department, dueDate, supportingDoc,
      payeeBank, payeeAccountHolder, payeeAccountNumber, paymentMethod, vehicleId,
    } = req.body as any;
    const data: any = {};
    if (paymentType !== undefined) data.paymentType = paymentType;
    if (payee !== undefined) data.payee = payee;
    if (amount !== undefined) data.amount = Number(amount);
    if (description !== undefined) data.description = description;
    if (referenceType !== undefined) data.referenceType = referenceType;
    if (referenceId !== undefined) data.referenceId = referenceId;
    if (department !== undefined) data.department = department || null;
    if (dueDate !== undefined) data.dueDate = dueDate ? new Date(dueDate) : null;
    if (supportingDoc !== undefined) data.supportingDoc = supportingDoc || null;
    if (payeeBank !== undefined) data.payeeBank = payeeBank || null;
    if (payeeAccountHolder !== undefined) data.payeeAccountHolder = payeeAccountHolder || null;
    if (payeeAccountNumber !== undefined) data.payeeAccountNumber = payeeAccountNumber || null;
    if (paymentMethod !== undefined) data.paymentMethod = paymentMethod || null;
    if (vehicleId !== undefined) data.vehicleId = vehicleId || null;
    const request = await prisma.paymentRequest.update({ where: { id: req.params.id }, data });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// DELETE /:id - Delete a draft payment request (creator only, draft only)
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'draft') {
      return res.status(400).json({ error: 'Only draft payment requests can be deleted' });
    }
    if (existing.requestedById && existing.requestedById !== req.user?.id
        && req.user?.role !== 'owner' && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only the creator or an admin can delete this draft' });
    }
    await prisma.paymentRequest.delete({ where: { id: req.params.id } });
    return res.json({ success: true });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/submit - Submit a draft request
router.put('/:id/submit', async (req: AuthRequest, res: Response) => {
  try {
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'draft') return res.status(400).json({ error: 'Only draft requests can be submitted' });

    const request = await prisma.paymentRequest.update({
      where: { id: req.params.id },
      data: { status: 'submitted' },
    });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/approve - Approve a submitted request (owner/admin only)
router.put('/:id/approve', async (req: AuthRequest, res: Response) => {
  try {
    const role = req.user?.role;
    if (role !== 'owner' && role !== 'admin') {
      return res.status(403).json({ error: 'Only owner or admin can approve payment requests' });
    }
    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'submitted') return res.status(400).json({ error: 'Only submitted requests can be approved' });

    const request = await prisma.paymentRequest.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedById: req.user?.id, approvedAt: new Date() },
    });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/reject - Reject a request with reason
router.put('/:id/reject', async (req: AuthRequest, res: Response) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'reason required' });

    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'submitted' && existing.status !== 'approved') {
      return res.status(400).json({ error: 'Only submitted or approved requests can be rejected' });
    }

    const request = await prisma.paymentRequest.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectedById: req.user?.id, rejectedReason: reason },
    });
    return res.json({ request });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// PUT /:id/pay - Execute payment
router.put('/:id/pay', async (req: AuthRequest, res: Response) => {
  try {
    const { cashierId } = req.body;

    const existing = await prisma.paymentRequest.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Payment request not found' });
    if (existing.status !== 'approved') return res.status(400).json({ error: 'Only approved requests can be paid' });

    let targetCashier: any = null;

    if (cashierId && String(cashierId).trim()) {
      const trimmedId = String(cashierId).trim();
      targetCashier = await prisma.cashier.findFirst({
        where: {
          OR: [
            { id: trimmedId },
            { userId: trimmedId },
            { code: trimmedId },
          ],
        }
      });
      if (!targetCashier) {
        // also check by case-insensitive name
        targetCashier = await prisma.cashier.findFirst({
          where: { name: { equals: trimmedId, mode: 'insensitive' } }
        });
      }
    } else if (req.user?.id) {
      // Auto-resolve to user's active cashier record
      targetCashier = await prisma.cashier.findFirst({
        where: { userId: req.user.id, isActive: true }
      });
      if (!targetCashier) {
        // fallback to first active cashier
        targetCashier = await prisma.cashier.findFirst({ where: { isActive: true } });
      }
    }

    if (!targetCashier) {
      return res.status(404).json({
        error: 'Cashier not found. Please specify a valid Cashier ID, User ID, or Code.'
      });
    }

    if (targetCashier.currentBalance < existing.amount) {
      return res.status(400).json({
        error: `Insufficient cashier balance. Cashier "${targetCashier.name}" has ETB ${targetCashier.currentBalance.toLocaleString()} but request requires ETB ${existing.amount.toLocaleString()}.`
      });
    }

    const resolvedCashierId = targetCashier.id;

    await prisma.$transaction(async (tx: any) => {
      const cashTx = await tx.cashTransaction.create({
        data: {
          cashierId: resolvedCashierId,
          type: 'out',
          category: existing.paymentType,
          amount: existing.amount,
          referenceId: existing.id,
          referenceType: 'payment_request',
          receiverName: existing.payee,
          paymentMethod: existing.paymentMethod || 'cash',
          description: `Payment: ${existing.requestNumber || existing.id} - ${existing.payee}`,
          approvedBy: req.user?.name || req.user?.id,
          approvedAt: new Date(),
        },
      });
      await tx.cashier.update({
        where: { id: resolvedCashierId },
        data: { currentBalance: { decrement: existing.amount } }
      });
      await tx.paymentRequest.update({
        where: { id: req.params.id },
        data: {
          status: 'paid',
          paidAmount: existing.amount,
          paidById: req.user?.id,
          paidAt: new Date(),
          cashTransactionId: cashTx.id,
        },
      });
    });

    return res.json({
      message: 'Payment executed successfully',
      cashier: { id: targetCashier.id, name: targetCashier.name, code: targetCashier.code }
    });
  } catch (e: any) { return res.status(500).json({ error: e.message }); }
});

export default router;
