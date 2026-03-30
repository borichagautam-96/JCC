import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import authRouter from '../routes/auth.js';
import invoicesRouter from '../routes/invoices.js';
import { JWT_SECRET } from '../middleware/auth.js';

const createTestApp = (router, basePath) => {
  const app = express();
  app.use(express.json());
  app.use(basePath, router);
  return app;
};

test('POST /api/auth/login returns validation error for missing identifier and password', async () => {
  const app = createTestApp(authRouter, '/api/auth');

  const response = await request(app)
    .post('/api/auth/login')
    .set('X-Device-ID', 'test-device-001')
    .send({});

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Validation failed');
  assert.ok(Array.isArray(response.body.details));
  assert.ok(response.body.details.length > 0);
});

test('POST /api/invoices/upload returns validation error when assignedTo is missing', async () => {
  const app = createTestApp(invoicesRouter, '/api/invoices');

  const token = jwt.sign(
    {
      id: 1,
      name: 'Admin User',
      email: 'admin@jcc.com',
      role: 'admin',
      ps_number: '123455',
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );

  const response = await request(app)
    .post('/api/invoices/upload')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Device-ID', 'test-device-001')
    .field('vendorName', 'Test Vendor')
    .field('invoiceNumber', 'INV-1001')
    .field('amount', '1000');

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'Validation failed');
  assert.ok(Array.isArray(response.body.details));
  assert.ok(response.body.details.some((item) => item.field.includes('assignedTo')));
});
