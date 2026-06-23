import { readJson, writeJson } from "./storage.js";

const STATE_FILE = "youtube-quota.json";
const YOUTUBE_QUOTA_TZ = "America/Los_Angeles";

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback, min = 0, max = 1440) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function quotaCooldownEnabled(scope) {
  if (!boolEnv("YOUTUBE_QUOTA_COOLDOWN_ENABLED", true)) return false;
  if (scope === "upload") return boolEnv("YOUTUBE_UPLOAD_QUOTA_COOLDOWN_ENABLED", true);
  if (scope === "data_api") return boolEnv("YOUTUBE_DATA_API_QUOTA_COOLDOWN_ENABLED", true);
  return true;
}

function timeZoneParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour,
    minute: parts.minute,
    second: parts.second
  };
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = timeZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtc(parts, timeZone) {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0
  );
  let utcMs = localAsUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    utcMs = localAsUtc - timeZoneOffsetMs(new Date(utcMs), timeZone);
  }
  return new Date(utcMs);
}

function nextYoutubeQuotaResetAt(now = new Date()) {
  const currentPacific = timeZoneParts(now, YOUTUBE_QUOTA_TZ);
  const nextPacificDate = new Date(Date.UTC(
    currentPacific.year,
    currentPacific.month - 1,
    currentPacific.day + 1
  ));
  const reset = zonedTimeToUtc({
    year: nextPacificDate.getUTCFullYear(),
    month: nextPacificDate.getUTCMonth() + 1,
    day: nextPacificDate.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0
  }, YOUTUBE_QUOTA_TZ);
  const bufferMinutes = numberEnv("YOUTUBE_QUOTA_RESET_BUFFER_MINUTES", 30, 0, 180);
  return new Date(reset.getTime() + bufferMinutes * 60 * 1000);
}

function normalizeState(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeScope(scope) {
  return scope === "data_api" ? "data_api" : "upload";
}

export async function getYoutubeQuotaState() {
  return normalizeState(await readJson(STATE_FILE, {}));
}

export async function youtubeQuotaCooldown(scope = "upload", now = new Date()) {
  const key = normalizeScope(scope);
  if (!quotaCooldownEnabled(key)) return { active: false, scope: key };

  const state = await getYoutubeQuotaState();
  const entry = normalizeState(state[key]);
  const untilMs = Date.parse(entry.quota_exceeded_until || "");
  if (Number.isFinite(untilMs) && untilMs > now.getTime()) {
    return {
      active: true,
      scope: key,
      until: new Date(untilMs).toISOString(),
      reason: entry.last_error || "youtube_quota_exceeded"
    };
  }

  return { active: false, scope: key };
}

export async function markYoutubeQuotaExceeded(scope = "upload", error = "") {
  const key = normalizeScope(scope);
  if (!quotaCooldownEnabled(key)) return { skipped: true, scope: key };

  const state = await getYoutubeQuotaState();
  const now = new Date();
  const until = nextYoutubeQuotaResetAt(now);
  state[key] = {
    ...(normalizeState(state[key])),
    quota_exceeded_at: now.toISOString(),
    quota_exceeded_until: until.toISOString(),
    last_error: String(error || "youtube_quota_exceeded").slice(0, 1000)
  };
  await writeJson(STATE_FILE, state);
  return { skipped: false, scope: key, until: until.toISOString() };
}

export async function clearYoutubeQuotaExceeded(scope = "upload") {
  const key = normalizeScope(scope);
  const state = await getYoutubeQuotaState();
  const entry = normalizeState(state[key]);
  if (!entry.quota_exceeded_until && !entry.last_error) return { changed: false, scope: key };

  state[key] = {
    ...entry,
    quota_exceeded_until: "",
    last_cleared_at: new Date().toISOString()
  };
  await writeJson(STATE_FILE, state);
  return { changed: true, scope: key };
}
