import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSessionHours, buildSessionConfig } from '../utils/sessionConfig.js';

test('clampSessionHours enforces lower and upper bounds', () => {
  assert.equal(clampSessionHours(0), 1);
  assert.equal(clampSessionHours(200), 72);
  assert.equal(clampSessionHours(8), 8);
});

test('buildSessionConfig returns expected derived values', () => {
  const cfg = buildSessionConfig(6);
  assert.equal(cfg.hours, 6);
  assert.equal(cfg.durationMs, 6 * 60 * 60 * 1000);
  assert.equal(cfg.jwtExpiresIn, '6h');
});

test('buildSessionConfig falls back for invalid values', () => {
  const cfg = buildSessionConfig('not-a-number', 8);
  assert.equal(cfg.hours, 8);
  assert.equal(cfg.jwtExpiresIn, '8h');
});
