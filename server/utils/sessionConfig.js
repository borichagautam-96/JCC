export const clampSessionHours = (value, fallback = 8) => {
  const parsed = Number.parseInt(String(value ?? fallback), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < 1) return 1;
  if (parsed > 72) return 72;
  return parsed;
};

export const buildSessionConfig = (hoursLike, fallback = 8) => {
  const hours = clampSessionHours(hoursLike, fallback);
  return {
    hours,
    durationMs: hours * 60 * 60 * 1000,
    jwtExpiresIn: `${hours}h`,
  };
};
