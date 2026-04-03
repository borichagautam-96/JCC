import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import invoiceRoutes from './routes/invoices.js';
import jccRoutes from './routes/jcc.js';
import dashboardRoutes from './routes/dashboard.js';
import usersRoutes from './routes/users.js';
import customerRoutes from './routes/customers.js';
import projectRoutes from './routes/projects.js';
import correspondenceRoutes from './routes/correspondences.js';

import letterRoutes from './routes/letters.js';
import purchaseOrderRoutes from './routes/purchaseOrders.js';
import vendorRoutes from './routes/vendors.js';
import assetRoutes from './routes/assets.js';
import { startReturnReminderScheduler } from './services/returnReminderService.js';
import { startJccApprovalReminderScheduler } from './services/jccApprovalReminderService.js';
import { startActivityLogRetentionScheduler } from './services/activityLogRetentionService.js';
import { env, validateStartupEnv } from './config/env.js';
import { apiLimiter } from './middleware/rateLimit.js';

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = env.port;

const startupWarnings = validateStartupEnv();
startupWarnings.forEach((warning) => {
    console.warn(`[ENV WARNING] ${warning}`);
});

// Middleware
app.use(cors());
app.use(
    helmet({
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        contentSecurityPolicy: false,
    })
);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api', apiLimiter);

// Serve uploaded files statically
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../dist')));

// Request logging
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/jcc', jccRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/correspondences', correspondenceRoutes);

app.use('/api/letters', letterRoutes);
app.use('/api/purchase-orders', purchaseOrderRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/assets', assetRoutes);

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'InFloAI Server is running' });
});

// Ensure unmatched API routes return JSON instead of SPA HTML
app.use('/api', (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.originalUrl}` });
});

// Handle SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
    console.log('\n🚀 InFloAI Server');
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log(`💾 Database initialized`);
    console.log(`\n✅ Ready to accept connections\n`);
});

startReturnReminderScheduler();
startJccApprovalReminderScheduler();
startActivityLogRetentionScheduler();

export default app;
