import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

import authRoutes from './routes/auth';
import vehicleRoutes from './routes/vehicles';
import employeeRoutes from './routes/employees';
import customerRoutes from './routes/customers';
import tripRoutes from './routes/trips';
import maintenanceRoutes from './routes/maintenance';
import inventoryRoutes from './routes/inventory';
import procurementRoutes from './routes/procurement';
import cashierRoutes from './routes/cashier';
import rentalRoutes from './routes/rental';
import hrRoutes from './routes/hr';
import reportRoutes from './routes/reports';
import dashboardRoutes from './routes/dashboard';
import notificationRoutes from './routes/notifications';
import handoverRoutes from './routes/handover';
import driverLedgerRoutes from './routes/driver-ledger';
import complianceRoutes from './routes/compliance';
import profitabilityRoutes from './routes/profitability';
import auditRoutes from './routes/audit';
import telegramRoutes from './routes/telegram';
import trackingRoutes from './routes/tracking';
import mainCashRoutes from './routes/main-cash';
import driverScoringRoutes from './routes/driver-scoring';
import driverRewardsRoutes from './routes/driver-rewards';
import dispatchRoutes from './routes/dispatch';
import documentRoutes from './routes/documents';
import accountingRoutes from './routes/accounting';
import portalRoutes from './routes/portal';
import settlementRoutes from './routes/settlements';
import orderRevisionRoutes from './routes/order-revisions';
import penaltyRoutes from './routes/penalties';
import cashTransferRoutes from './routes/cash-transfers';
import approvalRoutes from './routes/approvals';
import alertRoutes from './routes/alerts';
import fuelControlRoutes from './routes/fuel-control';
import accidentRoutes from './routes/accidents';
import revenueShareRoutes from './routes/revenue-share';
import brokerRoutes from './routes/brokers';
import companyDocRoutes from './routes/company-docs';
import paymentRequestRoutes from './routes/payment-requests';
import searchRoutes from './routes/search';

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static files for uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/vehicles', vehicleRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/trips', tripRoutes);
app.use('/api/maintenance', maintenanceRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/procurement', procurementRoutes);
app.use('/api/cashier', cashierRoutes);
app.use('/api/rental', rentalRoutes);
app.use('/api/hr', hrRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/handovers', handoverRoutes);
app.use('/api/driver-ledger', driverLedgerRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/profitability', profitabilityRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/telegram', telegramRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/main-cash', mainCashRoutes);
app.use('/api/driver-scoring', driverScoringRoutes);
app.use('/api/driver-rewards', driverRewardsRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/accounting', accountingRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/settlements', settlementRoutes);
app.use('/api/order-revisions', orderRevisionRoutes);
app.use('/api/penalties', penaltyRoutes);
app.use('/api/cash-transfers', cashTransferRoutes);
app.use('/api/approvals', approvalRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/fuel-control', fuelControlRoutes);
app.use('/api/accidents', accidentRoutes);
app.use('/api/revenue-share', revenueShareRoutes);
app.use('/api/brokers', brokerRoutes);
app.use('/api/company-docs', companyDocRoutes);
app.use('/api/payment-requests', paymentRequestRoutes);
app.use('/api/search', searchRoutes);

app.get('/api/health', (_, res) => res.json({ status: 'ok', time: new Date() }));

// ─── Serve the frontend SPA ──────────────────────────────────────────────────
// In production the backend serves the built frontend so a single port (5000)
// covers the whole app: frontend + /api + /uploads. The reverse proxy then only
// needs one proxy_pass. Override the path with FRONTEND_DIST if needed.
const frontendDist = process.env.FRONTEND_DIST || path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  // SPA fallback: any non-API, non-uploads GET returns index.html so client-side
  // routing (React Router) works on hard refresh / deep links.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log(`🖥️  Serving frontend from ${frontendDist}`);
} else {
  console.log(`⚠️  Frontend dist not found at ${frontendDist} — serving API only`);
}

app.listen(PORT, () => {
  console.log(`🚛 Wonde Transport ERP server running on port ${PORT}`);
});

export default app;
