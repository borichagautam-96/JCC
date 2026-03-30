import db from '../database.js';
import { getIntSetting } from '../utils/appSettings.js';

const DEFAULT_RETENTION_DAYS = 180;

export const runActivityLogRetentionJob = () => {
  try {
    const retentionDays = Math.max(7, getIntSetting('activity_log_retention_days', DEFAULT_RETENTION_DAYS));

    const rowsToArchive = db.prepare(`
      SELECT
        id, user_id, user_name, session_id, device_id, event_name,
        module, screen, entity_type, entity_id, duration_ms, success,
        status_code, metadata, ip_address, user_agent, created_at
      FROM user_activity_logs
      WHERE datetime(created_at) < datetime('now', '-' || ? || ' day')
      ORDER BY id ASC
      LIMIT 2000
    `).all(retentionDays);

    if (!rowsToArchive.length) {
      return { archived: 0, deleted: 0, retentionDays };
    }

    rowsToArchive.forEach((row) => {
      db.prepare(`
        INSERT OR IGNORE INTO user_activity_logs_archive (
          source_log_id, user_id, user_name, session_id, device_id, event_name,
          module, screen, entity_type, entity_id, duration_ms, success,
          status_code, metadata, ip_address, user_agent, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.user_id,
        row.user_name,
        row.session_id,
        row.device_id,
        row.event_name,
        row.module,
        row.screen,
        row.entity_type,
        row.entity_id,
        row.duration_ms,
        row.success,
        row.status_code,
        row.metadata,
        row.ip_address,
        row.user_agent,
        row.created_at,
      );
    });

    const ids = rowsToArchive.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(', ');

    db.prepare(`
      DELETE FROM user_activity_logs
      WHERE id IN (${placeholders})
    `).run(...ids);

    return { archived: rowsToArchive.length, deleted: rowsToArchive.length, retentionDays };
  } catch (error) {
    console.error('Activity retention job failed:', error);
    return { archived: 0, deleted: 0, error: error.message };
  }
};

export const startActivityLogRetentionScheduler = () => {
  runActivityLogRetentionJob();

  const interval = setInterval(() => {
    runActivityLogRetentionJob();
  }, 24 * 60 * 60 * 1000);

  return interval;
};
