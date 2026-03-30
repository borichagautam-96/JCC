import db from '../database.js';

const DEFAULT_SETTINGS = {
  session_timeout_hours: '8',
  return_maker_checker_enabled: '0',
  return_reminder_advance_days: '2',
  reminder_email_roles: 'admin,manager,coordinator,final_approver',
  reminder_notification_roles: 'admin,manager,coordinator,final_approver',
};

export const getSetting = (key, fallback = null) => {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return fallback ?? DEFAULT_SETTINGS[key] ?? null;
  return row.value;
};

export const getIntSetting = (key, fallback = 0) => {
  const value = Number.parseInt(String(getSetting(key, String(fallback))), 10);
  return Number.isFinite(value) ? value : fallback;
};

export const getBoolSetting = (key, fallback = false) => {
  const value = String(getSetting(key, fallback ? '1' : '0')).toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
};

export const getRoleListSetting = (key, fallback = []) => {
  const raw = String(getSetting(key, Array.isArray(fallback) ? fallback.join(',') : String(fallback || '')) || '');
  return raw
    .split(',')
    .map((role) => role.trim().toLowerCase())
    .filter(Boolean);
};

export const setSetting = (key, value) => {
  const nextValue = String(value ?? '');
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, nextValue);
  return nextValue;
};

export const getAllAppSettings = () => {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const mapped = { ...DEFAULT_SETTINGS };
  rows.forEach((row) => {
    mapped[row.key] = row.value;
  });
  return mapped;
};
