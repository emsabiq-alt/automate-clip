import fs from "node:fs/promises";
import path from "node:path";
import { config, shouldUploadToRemote } from "./config.js";
import { ensureProjectDirs, readJson, writeJson } from "./storage.js";
import { withRemoteClient } from "./uploader.js";
import { appendLog } from "./logger.js";

const stateFiles = [
  "themes.json",
  "videos.json",
  "prompts.json",
  "jobs.json",
  "history.json",
  "discovery-cache.json",
  "youtube-quota.json"
];

// File yang harus DI-MERGE dengan state lokal (cache GitHub Actions), bukan
// ditimpa mentah. Ini mencegah snapshot SFTP yang basi (mis. run sebelumnya
// gagal upload karena timeout) menimpa progres terbaru dari cache runner,
// yang merupakan akar duplikasi upload.
const mergeStrategies = {
  "videos.json": { key: "id", pickNewer: pickNewerVideo },
  "jobs.json": { key: "job_id", pickNewer: pickNewerByUpdatedAt },
  "history.json": { key: null } // union by identity, history bersifat append-only
};

function remoteStateDir() {
  return path.posix.join(config.ftp.remoteDir, "state");
}

function toTime(value) {
  const t = Date.parse(value || "");
  return Number.isFinite(t) ? t : 0;
}

function pickNewerByUpdatedAt(localItem, remoteItem) {
  const localT = Math.max(toTime(localItem?.updated_at), toTime(localItem?.created_at));
  const remoteT = Math.max(toTime(remoteItem?.updated_at), toTime(remoteItem?.created_at));
  return remoteT > localT ? remoteItem : localItem;
}

// Untuk video record: pilih yang paling "maju" dalam seri, lalu yang terbaru.
// series_success_count tidak boleh mundur (anti-duplikat), dan ledger range
// digabung dari kedua sisi.
function pickNewerVideo(localItem, remoteItem) {
  const base = pickNewerByUpdatedAt(localItem, remoteItem);
  const localSucc = Number(localItem?.series_success_count || 0);
  const remoteSucc = Number(remoteItem?.series_success_count || 0);
  const maxSucc = Math.max(
    Number.isFinite(localSucc) ? localSucc : 0,
    Number.isFinite(remoteSucc) ? remoteSucc : 0
  );

  const mergedRanges = mergeRangeLedger(
    Array.isArray(localItem?.series_clip_ranges) ? localItem.series_clip_ranges : [],
    Array.isArray(remoteItem?.series_clip_ranges) ? remoteItem.series_clip_ranges : []
  );

  const merged = { ...base };
  if (maxSucc > 0 || mergedRanges.length) {
    merged.series_success_count = maxSucc;
    if (mergedRanges.length) merged.series_clip_ranges = mergedRanges;
    const target = Number(base?.series_target_count || localItem?.series_target_count || remoteItem?.series_target_count || 0);
    if (target > 0) merged.series_remaining_count = Math.max(0, target - maxSucc);
  }
  return merged;
}

function mergeRangeLedger(a, b) {
  const seen = new Set();
  const result = [];
  for (const range of [...a, ...b]) {
    const start = Number(range?.start);
    const end = Number(range?.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const key = `${Math.round(start)}-${Math.round(end)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ start: Math.round(start * 100) / 100, end: Math.round(end * 100) / 100 });
  }
  return result;
}

function historyIdentity(entry = {}) {
  return [
    entry.job_id || "",
    entry.clip_index ?? "",
    entry.youtube_video_id || "",
    entry.instagram_media_id || "",
    entry.facebook_video_id || "",
    entry.threads_media_id || "",
    entry.recorded_at || ""
  ].join("|");
}

function mergeArrays(localList, remoteList, strategy) {
  const local = Array.isArray(localList) ? localList : [];
  const remote = Array.isArray(remoteList) ? remoteList : [];

  // History: union by identity, pertahankan urutan lokal lalu tambahkan entri
  // remote yang belum ada.
  if (!strategy.key) {
    const seen = new Set(local.map(historyIdentity));
    const merged = [...local];
    for (const entry of remote) {
      const id = historyIdentity(entry);
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(entry);
    }
    return merged;
  }

  // Keyed merge (videos/jobs): gabungkan berdasarkan key, pilih yang lebih baru.
  // Mulai dari remote, lalu overlay lokal (pilih yang lebih maju lewat pickNewer).
  const byKey = new Map();
  const extras = [];
  for (const item of remote) {
    const k = item?.[strategy.key];
    if (k == null) continue;
    byKey.set(k, item);
  }
  for (const item of local) {
    const k = item?.[strategy.key];
    if (k == null) {
      extras.push(item);
      continue;
    }
    const existing = byKey.get(k);
    byKey.set(k, existing ? strategy.pickNewer(item, existing) : item);
  }
  return [...byKey.values(), ...extras];
}

export async function downloadStateFromRemote() {
  if (!shouldUploadToRemote()) return { skipped: true };
  await ensureProjectDirs();
  const downloaded = [];
  const merged = [];

  await withRemoteClient(async (client) => {
    await client.ensureDir(remoteStateDir());
    const items = await client.list();
    const names = new Set(items.filter((item) => item.isFile).map((item) => item.name));
    for (const file of stateFiles) {
      if (!names.has(file)) continue;

      const strategy = mergeStrategies[file];
      if (!strategy) {
        // File tanpa strategi merge (themes/prompts/discovery/quota): timpa
        // seperti semula, ini bukan sumber anti-duplikat.
        await client.downloadTo(path.join(config.dataDir, file), file);
        downloaded.push(file);
        continue;
      }

      // Merge: baca lokal (cache runner), tarik remote ke file sementara, gabung.
      const localList = await readJson(file, []);
      const tempName = `${file}.remote`;
      const tempPath = path.join(config.dataDir, tempName);
      await client.downloadTo(tempPath, file);
      let remoteList = [];
      try {
        remoteList = JSON.parse(await fs.readFile(tempPath, "utf8"));
      } catch {
        remoteList = [];
      }
      await fs.rm(tempPath, { force: true });

      const mergedList = mergeArrays(localList, remoteList, strategy);
      await writeJson(file.replace(/\.json$/, ""), mergedList);
      merged.push(file);
    }
  }, { timeoutMs: config.ftp.stateTimeoutMs });

  await appendLog("state_download", { downloaded, merged }).catch(() => {});
  return { skipped: false, downloaded, merged };
}

export async function uploadStateToRemote() {
  if (!shouldUploadToRemote()) return { skipped: true };
  await ensureProjectDirs();
  const uploaded = [];

  await withRemoteClient(async (client) => {
    await client.ensureDir(remoteStateDir());
    for (const file of stateFiles) {
      const localPath = path.join(config.dataDir, file);
      try {
        await fs.access(localPath);
        await client.uploadFrom(localPath, file);
        uploaded.push(file);
      } catch {
        // Missing state file is allowed during first setup.
      }
    }
  }, { timeoutMs: config.ftp.stateTimeoutMs });

  return { skipped: false, uploaded };
}

// Exposed for unit tests of the merge logic (the core anti-duplicate guard).
export const __testables = { mergeArrays, mergeStrategies, mergeRangeLedger, historyIdentity };
