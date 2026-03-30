import db from '../database.js';

const SENSITIVE_KEY_PATTERN = /(pass(word)?|token|secret|authorization|cookie|api[-_]?key|session|otp|pin|cvv)/i;

const looksSensitiveString = (value) => {
  const text = String(value || '').toLowerCase();
  return (
    text.includes('bearer ') ||
    text.includes('password=') ||
    text.includes('token=') ||
    text.includes('authorization:')
  );
};

const sanitizeValue = (value, keyName = '', depth = 0) => {
  if (depth > 6) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;

  if (SENSITIVE_KEY_PATTERN.test(String(keyName || ''))) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, '', depth + 1));
  }

  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, sanitizeValue(inner, key, depth + 1)])
    );
  }

  if (typeof value === 'string') {
    if (looksSensitiveString(value)) return '[REDACTED]';
    return value.length > 1000 ? `${value.slice(0, 997)}...` : value;
  }

  return value;
};

export const sanitizeActivityMetadata = (value) => sanitizeValue(value, '', 0);

const toNullableInt = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const toSuccessFlag = (value) => {
  if (value === undefined || value === null) return 1;
  return value ? 1 : 0;
};

const safeJson = (value) => {
  try {
    return JSON.stringify(sanitizeActivityMetadata(value || {}));
  } catch {
    return '{}';
  }
};

export const logUserActivity = ({
  userId = null,
  userName = '',
  sessionId = '',
  deviceId = '',
  eventName,
  module = '',
  screen = '',
  entityType = '',
  entityId = null,
  durationMs = null,
  success = true,
  statusCode = null,
  metadata = {},
  ipAddress = '',
  userAgent = '',
}) => {
  if (!eventName) return;

  try {
    db.prepare(`
      INSERT INTO user_activity_logs (
        user_id, user_name, session_id, device_id, event_name,
        module, screen, entity_type, entity_id, duration_ms,
        success, status_code, metadata, ip_address, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      toNullableInt(userId),
      String(userName || '').trim() || null,
      String(sessionId || '').trim() || null,
      String(deviceId || '').trim() || null,
      String(eventName || '').trim(),
      String(module || '').trim() || null,
      String(screen || '').trim() || null,
      String(entityType || '').trim() || null,
      toNullableInt(entityId),
      toNullableInt(durationMs),
      toSuccessFlag(success),
      toNullableInt(statusCode),
      safeJson(metadata),
      String(ipAddress || '').trim() || null,
      String(userAgent || '').trim() || null,
    );
  } catch (error) {
    console.error('Activity log insert failed:', error);
  }
};
