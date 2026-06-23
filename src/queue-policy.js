export const DEFAULT_QUEUE_SERIES_TARGET_COUNT = 3;
export const DEFAULT_AUTOMATION_QUEUE_LINK_LIMIT = 5;
export const DEFAULT_SCHEDULED_CLIPS_PER_RUN = 1;
export const DEFAULT_CLIP_COUNT = 1;

function numberEnv(name, fallback, min = 0, max = 1000) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function queueSeriesTarget(video = {}) {
  const configured = Number(video.series_target_count);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return numberEnv("QUEUE_SERIES_TARGET_COUNT", DEFAULT_QUEUE_SERIES_TARGET_COUNT, 1, 20);
}

export function automationQueueLinkLimit() {
  return numberEnv("AUTOMATION_QUEUE_LINK_LIMIT", DEFAULT_AUTOMATION_QUEUE_LINK_LIMIT, 1, 50);
}

export function scheduledClipsPerRun() {
  return numberEnv("SCHEDULED_CLIPS_PER_RUN", DEFAULT_SCHEDULED_CLIPS_PER_RUN, 1, 10);
}

export function isAutomationSeriesVideo(video = {}) {
  return video.manual_run !== true && video.automation_series !== false;
}

export function storedQueueSeriesSuccessCount(video = {}) {
  const value = Number(video.series_success_count || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function roundSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100) / 100;
}

// Range clip yang sudah dipakai, disimpan otoritatif di record video (videos.json)
// supaya run berikutnya dalam satu queue-series tahu segmen mana yang harus dihindari,
// tanpa bergantung pada history.json global yang rawan ter-trim / lost-update.
export function storedSeriesClipRanges(video = {}) {
  const ranges = Array.isArray(video.series_clip_ranges) ? video.series_clip_ranges : [];
  return ranges
    .map((range) => ({ start: roundSeconds(range?.start), end: roundSeconds(range?.end) }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start);
}

export function dedupeClipRanges(ranges = []) {
  const seen = new Set();
  const result = [];
  for (const range of ranges) {
    const start = roundSeconds(range?.start);
    const end = roundSeconds(range?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const key = `${Math.round(start)}-${Math.round(end)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ start, end });
  }
  return result;
}

export function queueSeriesRemaining(video = {}, successCount = storedQueueSeriesSuccessCount(video)) {
  return Math.max(0, queueSeriesTarget(video) - successCount);
}

export function isQueueSeriesComplete(video = {}, successCount = storedQueueSeriesSuccessCount(video)) {
  return queueSeriesRemaining(video, successCount) <= 0;
}

// Jumlah klip yang harus dirender untuk satu link series dalam SATU run.
// Saat fresh = full target (mis. 3); saat sebagian sudah sukses, hanya sisanya.
// Merender semua klip sekaligus dalam satu proses clipper menjamin klip tidak
// saling tumpang tindih tanpa bergantung pada sinkronisasi state antar-run.
export function seriesClipsForRun(video = {}, successCount = storedQueueSeriesSuccessCount(video)) {
  return queueSeriesRemaining(video, successCount);
}
