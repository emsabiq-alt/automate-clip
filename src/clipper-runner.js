import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { queueSeriesClipRanges } from "./history.js";
import { dedupeClipRanges, isAutomationSeriesVideo, storedSeriesClipRanges } from "./queue-policy.js";

function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function secondsInput(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(value, min), max);
}

function minutesLabel(ms) {
  return `${Math.round(ms / 60000)} menit`;
}

function stopProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true })
      .on("error", () => {});
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export async function runClipper({ video, job, onLog = () => {} }) {
  const clipperRoot = config.clipper.rootDir;
  const scriptPath = path.join(clipperRoot, "scripts", "clipper.py");
  await assertFile(scriptPath, "Clipper script tidak ditemukan");

  const startedAt = Date.now();
  const args = ["scripts/clipper.py", video.url || video.source_url];
  if (video.manual_range) {
    args.push("--range", video.manual_range);
  }
  const avoidRanges = await clipRangesToAvoid(video);
  for (const range of avoidRanges) {
    args.push("--avoid-range", `${range.start}-${range.end}`);
  }

  const quality = qualityPreset(video.quality_profile);
  const sceneMode = String(video.scene_mode || process.env.SCENE_MODE || process.env.SMART_CROP_MODE || "podcast");
  const clipCount = String(video.clip_count || process.env.CLIP_COUNT || config.clipper.clipCount);
  const selectionOffset = queueSeriesSelectionOffset(video, avoidRanges.length);
  const useSubtitleHighlight = boolInput(
    video.use_subtitle_highlight ?? job.use_subtitle_highlight,
    boolInput(process.env.SUBTITLE_WORD_HIGHLIGHT_ENABLED, true)
  );
  const useEmojiPopup = boolInput(
    video.use_subtitle_emoji_popup ?? job.use_subtitle_emoji_popup,
    boolInput(process.env.SUBTITLE_EMOJI_POPUP_ENABLED, true)
  );
  const subtitleMarginV = Math.max(
    550,
    Number(video.subtitle_margin_v || process.env.SUBTITLE_MARGIN_V || 550) || 550
  );
  const env = {
    ...process.env,
    CLIP_COUNT: clipCount,
    MIN_CLIP_SECONDS: String(config.clipper.minClipSeconds),
    MAX_CLIP_SECONDS: String(config.clipper.maxClipSeconds),
    DOWNLOAD_MAX_HEIGHT: String(quality.downloadMaxHeight),
    DOWNLOAD_COMPRESS_CRF: String(quality.downloadCrf),
    FINAL_RENDER_CRF: String(quality.finalCrf),
    SUBTITLE_FONT_FAMILY: String(video.subtitle_font || process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold"),
    SUBTITLE_FONT_SIZE: String(video.subtitle_font_size || process.env.SUBTITLE_FONT_SIZE || 56),
    SUBTITLE_MARGIN_V: String(subtitleMarginV),
    SUBTITLE_MARGIN_H: String(video.subtitle_margin_h || process.env.SUBTITLE_MARGIN_H || 80),
    SUBTITLE_WORD_HIGHLIGHT_ENABLED: useSubtitleHighlight ? "1" : "0",
    SUBTITLE_EMOJI_POPUP_ENABLED: useEmojiPopup ? "1" : "0",
    CLIP_SELECTION_OFFSET: String(selectionOffset),
    SCENE_MODE: sceneMode,
    SMART_CROP_MODE: sceneMode,
    THEME: String(video.theme || job.theme || config.defaultTheme || ""),
    BACKGROUND_MUSIC_ENABLED: boolInput(video.use_music ?? job.use_music, boolInput(process.env.BACKGROUND_MUSIC_ENABLED, true)) ? "1" : "0"
  };

  const hardTimeoutMs = secondsInput("CLIPPER_TIMEOUT_SECONDS", 2700, 300, 7200) * 1000;
  const idleTimeoutMs = secondsInput("CLIPPER_IDLE_TIMEOUT_SECONDS", 1200, 300, 3600) * 1000;

  onLog(`Running clipper: ${config.clipper.pythonCommand} ${args.join(" ")}`);
  if (avoidRanges.length) {
    onLog(`Queue series avoid ranges: ${avoidRanges.map((range) => `${range.start}-${range.end}`).join(", ")}`);
  }
  if (selectionOffset > 0) {
    onLog(`Queue series candidate offset: ${selectionOffset}`);
  }
  onLog(`Clipper watchdog: hard ${minutesLabel(hardTimeoutMs)}, idle ${minutesLabel(idleTimeoutMs)}`);

  const output = await new Promise((resolve, reject) => {
    const child = spawn(config.clipper.pythonCommand, args, {
      cwd: clipperRoot,
      env,
      detached: process.platform !== "win32",
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer = null;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      callback(value);
    };

    const abort = (message) => {
      if (settled) return;
      onLog(message);
      stopProcessTree(child);
      killTimer = setTimeout(() => {
        if (!child.killed && child.pid) {
          try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }, 5000);
      killTimer.unref?.();
      finish(reject, new Error(message));
    };

    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abort(`Clipper idle timeout setelah ${minutesLabel(idleTimeoutMs)} tanpa log baru.`);
      }, idleTimeoutMs);
    };

    const hardTimer = setTimeout(() => {
      abort(`Clipper timeout setelah ${minutesLabel(hardTimeoutMs)}.`);
    }, hardTimeoutMs);
    let idleTimer = setTimeout(() => {
      abort(`Clipper idle timeout setelah ${minutesLabel(idleTimeoutMs)} tanpa log baru.`);
    }, idleTimeoutMs);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onLog(text.trim());
      resetIdleTimer();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onLog(text.trim());
      resetIdleTimer();
    });

    child.on("error", (error) => {
      finish(reject, error);
    });

    child.on("close", (code) => {
      if (settled) return;
      if (code === 0) finish(resolve, { stdout, stderr });
      else finish(reject, new Error(`Clipper failed with exit code ${code}: ${stderr || stdout}`));
    });
  });

  const parsed = extractResultJson(output.stdout) || await findLatestResult(clipperRoot, video.url || video.source_url, startedAt);
  if (!parsed) throw new Error("Clipper selesai, tetapi file result JSON tidak ditemukan.");

  return normalizeClipperResult(parsed, clipperRoot, job);
}

async function clipRangesToAvoid(video = {}) {
  if (!isAutomationSeriesVideo(video) || video.force_reprocess === true) return [];
  if (boolInput(process.env.QUEUE_SERIES_AVOID_PREVIOUS_CLIPS, true) !== true) return [];
  // Sumber utama: ledger range di record video (otoritatif, ikut queue item).
  // Fallback: history.json global, untuk data lama sebelum ledger ada.
  const storedRanges = storedSeriesClipRanges(video);
  const historyRanges = await queueSeriesClipRanges(video);
  return dedupeClipRanges([...storedRanges, ...historyRanges])
    .map((range) => ({
      start: secondsValue(range.start),
      end: secondsValue(range.end)
    }))
    .filter((range) => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .slice(-20);
}

function secondsValue(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number * 100) / 100;
}

function queueSeriesSelectionOffset(video = {}, avoidRangeCount = 0) {
  if (!isAutomationSeriesVideo(video) || video.force_reprocess === true) return 0;
  const successCount = Math.floor(Number(video.series_success_count || 0));
  if (!Number.isFinite(successCount) || successCount <= 0) return 0;
  return Math.max(0, successCount - Math.max(0, avoidRangeCount));
}

function qualityPreset(value) {
  const preset = String(value || process.env.VIDEO_QUALITY_PROFILE || "standard").toLowerCase();
  const profiles = {
    fast: {
      downloadMaxHeight: 480,
      downloadCrf: 32,
      finalCrf: 30
    },
    standard: {
      downloadMaxHeight: 720,
      downloadCrf: 30,
      finalCrf: 27
    },
    high: {
      downloadMaxHeight: 1080,
      downloadCrf: 24,
      finalCrf: 23
    },
    ultra: {
      downloadMaxHeight: 1080,
      downloadCrf: 20,
      finalCrf: 20
    }
  };
  return profiles[preset] || profiles.standard;
}

async function assertFile(filePath, message) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(message);
  } catch {
    throw new Error(`${message}: ${filePath}`);
  }
}

function extractResultJson(stdout) {
  const marker = '{\n  "jobId"';
  const index = stdout.lastIndexOf(marker);
  if (index === -1) return null;
  try {
    return JSON.parse(stdout.slice(index));
  } catch {
    return null;
  }
}

async function findLatestResult(clipperRoot, sourceUrl, startedAt) {
  const outputDir = path.join(clipperRoot, "output");
  let entries = [];
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("py-result-") || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(outputDir, entry.name);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < startedAt - 5000) continue;
    files.push({ fullPath, mtime: stat.mtimeMs });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files) {
    try {
      const data = JSON.parse(await fs.readFile(file.fullPath, "utf8"));
      if (!sourceUrl || data.sourceUrl === sourceUrl) return data;
    } catch {
      // Try the next result file.
    }
  }
  return null;
}

function normalizeClipperResult(result, clipperRoot, job) {
  const outputs = Array.isArray(result.outputs) ? result.outputs : [];
  return {
    ...result,
    automationJobId: job.job_id,
    clipperRoot,
    outputs: outputs.map((item) => ({
      ...item,
      finalAbsPath: item.finalPath ? path.resolve(clipperRoot, item.finalPath) : "",
      subtitleAbsPath: item.subtitlePath ? path.resolve(clipperRoot, item.subtitlePath) : "",
      transcriptReviewAbsPath: item.transcriptReviewPath ? path.resolve(clipperRoot, item.transcriptReviewPath) : "",
      smartCropAbsPath: item.smartCropPath ? path.resolve(clipperRoot, item.smartCropPath) : ""
    }))
  };
}
