import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { generateThumbnailSpeech } from "./deepgram-tts.js";

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const BOX_MARGIN_X = 60;
const BOX_W = CANVAS_WIDTH - (BOX_MARGIN_X * 2);
const BOX_PADDING_X = 36;
const BOX_PADDING_Y = 30;
const BOX_BOTTOM_OFFSET = Number(process.env.THUMBNAIL_BOTTOM_OFFSET || 480);
const BOX_MAX_HEIGHT = 380;
const MAX_TITLE_LINES = 4;
const MAX_TITLE_WORDS = 16;
const DEFAULT_TITLE_TEXT = "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL";
const FONT_SIZE_MAX = 74;
const FONT_SIZE_MIN = 22;
const CHAR_WIDTH_RATIO = 0.62;
const TEXT_COLOR = process.env.THUMBNAIL_TEXT_COLOR || "0xFFD60A";
const BORDER_COLOR = process.env.THUMBNAIL_BORDER_COLOR || "0xFFD60A";
const BG_COLOR = process.env.THUMBNAIL_BG_COLOR || "0x000000";
const BG_OPACITY = clampOpacity(process.env.THUMBNAIL_BG_OPACITY, 0.6);
const BORDER_OPACITY = clampOpacity(process.env.THUMBNAIL_BORDER_OPACITY, 0.85);
const TEXT_OUTLINE_OPACITY = clampOpacity(process.env.THUMBNAIL_TEXT_OUTLINE_OPACITY, 0.85);
const JPEG_Q = process.env.THUMBNAIL_JPEG_Q || "1";
const INTRO_SECONDS = clampSeconds(process.env.THUMBNAIL_INTRO_SECONDS, 0.9);
const INTRO_FREEZE_SEEK_SECONDS = clampDuration(process.env.THUMBNAIL_INTRO_FREEZE_SEEK_SECONDS, 0.8, 0, 5);
const TTS_PAD_SECONDS = clampDuration(process.env.THUMBNAIL_TTS_PAD_SECONDS, 0, 0, 2);
const TTS_MAX_SECONDS = clampDuration(process.env.THUMBNAIL_TTS_MAX_SECONDS, 12, 1, 30);
const DEFAULT_TRANSITION_ASSET = "assets/branding/transisi-thumbnail-to-content.mp4";
const TRANSITION_ENABLED = String(process.env.THUMBNAIL_TRANSITION_ENABLED || "").trim().toLowerCase() === "true";
const TRANSITION_ASSET = process.env.THUMBNAIL_TRANSITION_ASSET || DEFAULT_TRANSITION_ASSET;
const TRANSITION_KEY_COLOR = sanitizeColor(process.env.THUMBNAIL_TRANSITION_KEY_COLOR, "0x000000");
const TRANSITION_KEY_SIMILARITY = clampNumber(process.env.THUMBNAIL_TRANSITION_KEY_SIMILARITY, 0.18, 0, 1);
const TRANSITION_KEY_BLEND = clampNumber(process.env.THUMBNAIL_TRANSITION_KEY_BLEND, 0.04, 0, 1);
const TRANSITION_SPEED = clampNumber(process.env.THUMBNAIL_TRANSITION_SPEED, 1.28, 0.5, 3);
const THUMBNAIL_MIN_LUMA = clampNumber(process.env.THUMBNAIL_MIN_LUMA, 28, 0, 255);
const rendererPath = path.join(config.srcDir, "branding-renderer.py");

export async function generateThumbnail({ job, videoPath, text }) {
  await fs.mkdir(config.thumbnailDir, { recursive: true });
  const filename = `${job.job_id}-thumbnail.jpg`;
  const outputPath = path.join(config.thumbnailDir, filename);
  const basePath = path.join(config.thumbnailDir, `${job.job_id}-thumbnail-base.jpg`);

  const displayText = normalizeTitleText(text);
  const layout = buildTitleLayout(displayText);
  const fontOption = await resolveFontOption();
  const seek = await pickSeekTimestamp(videoPath);

  const baseFilters = [
    "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd+full_chroma_int",
    "crop=1080:1920",
    "unsharp=lx=5:ly=5:la=0.85:cx=5:cy=5:ca=0.4",
    "eq=contrast=1.05:saturation=1.10"
  ];

  try {
    await runFfmpeg([
      "-y",
      "-ss", seek,
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", baseFilters.join(","),
      "-q:v", JPEG_Q,
      basePath
    ]);
    await runRenderer([
      "thumbnail",
      "--input", basePath,
      "--output", outputPath,
      "--title", displayText,
      "--pill", process.env.THUMBNAIL_PILL_TEXT || "Podcast | Highlight | Viral"
    ]);
    await fs.rm(basePath, { force: true }).catch(() => {});
    return { path: outputPath, filename, text: displayText, frameTimestamp: seek };
  } catch (error) {
    await fs.rm(basePath, { force: true }).catch(() => {});
    console.warn(`Thumbnail renderer fallback dipakai: ${error.message}`);
  }

  const overlayFilter = [
    ...baseFilters,
    `drawbox=x=${BOX_MARGIN_X}:y=${layout.boxY}:w=${BOX_W}:h=${layout.boxH}:color=${BG_COLOR}@${BG_OPACITY}:t=fill`,
    `drawbox=x=${BOX_MARGIN_X}:y=${layout.boxY}:w=${BOX_W}:h=${layout.boxH}:color=${BORDER_COLOR}@${BORDER_OPACITY}:t=3`,
    ...layout.lines.map((line, idx) => (
      `drawtext=${fontOption}:text='${escapeDrawtext(line)}':fontcolor=${TEXT_COLOR}:fontsize=${layout.fontSize}:bordercolor=black@${TEXT_OUTLINE_OPACITY}:borderw=3:x=(w-text_w)/2:y=${layout.lineYs[idx]}`
    ))
  ].join(",");

  const fallbackFilter = baseFilters.join(",");

  try {
    await runFfmpeg([
      "-y",
      "-ss", seek,
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", overlayFilter,
      "-q:v", JPEG_Q,
      outputPath
    ]);
  } catch {
    await runFfmpeg([
      "-y",
      "-ss", seek,
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", fallbackFilter,
      "-q:v", JPEG_Q,
      outputPath
    ]);
  }

  return { path: outputPath, filename, text: displayText };
}

export async function prependThumbnailIntro({ job, videoPath, thumbnailPath, text = "" }) {
  if (!boolValue(process.env.THUMBNAIL_INTRO_ENABLED, true)) return null;
  if (!videoPath) return null;
  if (!await fileExists(videoPath)) return null;
  const introVisualMode = thumbnailIntroVisualMode();
  if (introVisualMode === "thumbnail" && (!thumbnailPath || !await fileExists(thumbnailPath))) return null;

  await fs.mkdir(config.generatedVideoDir, { recursive: true });
  const introPath = path.join(config.generatedVideoDir, `${job.job_id}-thumb-intro.mp4`);
  const outputPath = path.join(config.generatedVideoDir, `${job.job_id}-with-thumb-intro.mp4`);
  const introFramePath = path.join(config.generatedVideoDir, `${job.job_id}-tts-intro-frame.jpg`);

  const speech = await generateThumbnailSpeech({ job, text }).catch((error) => {
    console.warn(`TTS thumbnail dilewati: ${error.message}`);
    return null;
  });
  const speechDuration = speech?.path ? await probeDurationSeconds(speech.path) : null;
  const introSeconds = speechDuration
    ? clampDuration(speechDuration + TTS_PAD_SECONDS, INTRO_SECONDS, 0.3, TTS_MAX_SECONDS)
    : INTRO_SECONDS;
  const introSecondsArg = formatFfmpegSeconds(introSeconds);
  const introAudioFilter = buildIntroAudioFilter({ introSeconds: introSecondsArg, speech });
  const transition = await resolveThumbnailTransition();

  await Promise.all([
    fs.rm(introPath, { force: true }).catch(() => {}),
    fs.rm(outputPath, { force: true }).catch(() => {}),
    fs.rm(introFramePath, { force: true }).catch(() => {})
  ]);

  const visual = await resolveIntroVisual({
    videoPath,
    thumbnailPath,
    outputPath: introFramePath,
    visualMode: introVisualMode
  });

  const audioInputArgs = speech?.path
    ? ["-i", speech.path]
    : [
      "-f", "lavfi",
      "-t", String(introSeconds),
      "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"
    ];

  await runFfmpeg([
    "-y",
    "-loop", "1",
    "-framerate", "30",
    "-t", String(introSeconds),
    "-i", visual.path,
    ...audioInputArgs,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-vf", "setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,format=yuv420p",
    "-af", introAudioFilter,
    "-r", "30",
    "-fps_mode", "cfr",
    "-c:v", "libx264",
    "-preset", config.videoEffects.preset || "veryfast",
    "-crf", String(config.videoEffects.crf),
    "-bf", "0",
    "-g", "60",
    "-enc_time_base:v", "1:30",
    "-video_track_timescale", "30",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-t", String(introSeconds),
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-avoid_negative_ts", "disabled",
    "-movflags", "+faststart",
    introPath
  ]);

  await runFfmpeg([
    "-y",
    "-fflags", "+genpts",
    "-i", introPath,
    "-fflags", "+genpts",
    "-i", videoPath,
    ...(transition ? [
      "-stream_loop", "-1",
      "-fflags", "+genpts",
      "-i", transition.path
    ] : []),
    "-filter_complex",
    buildFinalConcatFilter({ introSecondsArg, transition }),
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", "libx264",
    "-preset", config.videoEffects.preset || "veryfast",
    "-crf", String(config.videoEffects.crf),
    "-pix_fmt", "yuv420p",
    "-bf", "0",
    "-g", "60",
    "-enc_time_base:v", "1:30",
    "-video_track_timescale", "30",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-muxpreload", "0",
    "-muxdelay", "0",
    "-avoid_negative_ts", "disabled",
    "-movflags", "+faststart",
    outputPath
  ]);

  return {
    path: outputPath,
    introPath,
    durationSeconds: introSeconds,
    visualMode: visual.mode,
    ttsApplied: Boolean(speech?.path),
    ttsAudioPath: speech?.path || "",
    ttsProvider: speech?.provider || "",
    ttsFallbackFrom: speech?.fallbackFrom || "",
    ttsFallbackError: speech?.fallbackError || "",
    ttsKeyIndex: speech?.keyIndex || "",
    ttsText: speech?.text || "",
    ttsModel: speech?.model || "",
    ttsVoice: speech?.voice || "",
    ttsSpeed: speech?.speed || "",
    ttsVolume: speech?.volume || "",
    transitionApplied: Boolean(transition),
    transitionPath: transition?.path || "",
    transitionDurationSeconds: transition?.durationSeconds || 0,
    transitionSourceDurationSeconds: transition?.sourceDurationSeconds || 0,
    transitionSpeed: transition?.speed || "",
    transitionKeyColor: transition?.keyColor || "",
    transitionKeySimilarity: transition?.keySimilarity ?? "",
    transitionKeyBlend: transition?.keyBlend ?? ""
  };
}

export function thumbnailIntroVisualMode(value = process.env.THUMBNAIL_IMAGE_INTRO_ENABLED) {
  return boolValue(value, true) ? "thumbnail" : "video";
}

async function resolveIntroVisual({ videoPath, thumbnailPath, outputPath, visualMode }) {
  if (visualMode === "thumbnail" && thumbnailPath && await fileExists(thumbnailPath)) {
    return { path: thumbnailPath, mode: "thumbnail" };
  }

  await runFfmpeg([
    "-y",
    "-ss", formatTimestamp(INTRO_FREEZE_SEEK_SECONDS),
    "-i", videoPath,
    "-frames:v", "1",
    "-vf", "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920",
    "-q:v", JPEG_Q,
    outputPath
  ]);
  return { path: outputPath, mode: "video_freeze_frame" };
}

function buildFinalConcatFilter({ introSecondsArg, transition }) {
  const filters = [
    "[0:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v0]"
  ];

  if (transition) {
    filters.push(
      "[1:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,fps=30,format=rgba[basev]",
      `[2:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,fps=30,trim=duration=${transition.sourceDurationArg},setpts=(PTS-STARTPTS)/${transition.speedArg},format=rgba,colorkey=${transition.keyColor}:${transition.keySimilarity}:${transition.keyBlend},format=rgba[tr]`,
      `[basev][tr]overlay=0:0:eof_action=pass:shortest=0:enable='between(t,0,${transition.durationArg})',format=yuv420p[v1]`
    );
  } else {
    filters.push("[1:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v1]");
  }

  filters.push(
    `[0:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS,apad,atrim=duration=${introSecondsArg}[a0]`,
    "[1:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a1]",
    "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"
  );
  return filters.join(";");
}

async function resolveThumbnailTransition() {
  if (!TRANSITION_ENABLED) return null;
  const transitionPath = path.isAbsolute(TRANSITION_ASSET)
    ? TRANSITION_ASSET
    : path.resolve(config.rootDir, TRANSITION_ASSET);
  if (!await fileExists(transitionPath)) {
    console.warn(`Transisi thumbnail dilewati: asset tidak ditemukan (${transitionPath})`);
    return null;
  }
  const durationSeconds = await probeDurationSeconds(transitionPath);
  if (!durationSeconds) {
    console.warn(`Transisi thumbnail dilewati: durasi asset tidak terbaca (${transitionPath})`);
    return null;
  }
  const sourceDurationSeconds = clampDuration(durationSeconds, 1.5, 0.2, 5);
  const durationArg = formatFfmpegSeconds(clampDuration(sourceDurationSeconds / TRANSITION_SPEED, 1.5, 0.2, 5));
  return {
    path: transitionPath,
    durationSeconds: Number(durationArg),
    durationArg,
    sourceDurationSeconds,
    sourceDurationArg: formatFfmpegSeconds(sourceDurationSeconds),
    speed: TRANSITION_SPEED,
    speedArg: formatFfmpegSeconds(TRANSITION_SPEED),
    keyColor: TRANSITION_KEY_COLOR,
    keySimilarity: TRANSITION_KEY_SIMILARITY,
    keyBlend: TRANSITION_KEY_BLEND
  };
}

function buildIntroAudioFilter({ introSeconds, speech }) {
  const filters = [
    "aresample=async=1:first_pts=0",
    "asetpts=PTS-STARTPTS"
  ];
  if (speech?.path) {
    filters.push(`volume=${formatFfmpegSeconds(speech.volume || 1)}`);
    filters.push("alimiter=limit=0.95");
  }
  filters.push("apad", `atrim=duration=${introSeconds}`);
  return filters.join(",");
}

function formatFfmpegSeconds(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "0.3";
  return number.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function runRenderer(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.clipper.pythonCommand, [rendererPath, ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `branding renderer exited with ${code}`));
    });
  });
}

function buildTitleLayout(value) {
  const title = String(value || DEFAULT_TITLE_TEXT)
    .replace(/\s+/g, " ")
    .trim();
  const textAreaW = BOX_W - (BOX_PADDING_X * 2);
  let fontSize = FONT_SIZE_MAX;
  let lines = [];

  while (fontSize >= FONT_SIZE_MIN) {
    const maxChars = Math.max(10, Math.floor(textAreaW / (fontSize * CHAR_WIDTH_RATIO)));
    // Bungkus natural (maxLines besar) supaya judul tidak dipotong "..."; cukup
    // kecilkan font sampai muat penuh dalam maksimal MAX_TITLE_LINES baris.
    lines = wrapText(title, maxChars, 99);
    const textBlockH = estimateTextBlockHeight(lines.length, fontSize);
    const widthOk = lines.every((line) => estimateTextWidth(line, fontSize) <= textAreaW);
    const heightOk = (textBlockH + BOX_PADDING_Y * 2) <= BOX_MAX_HEIGHT;
    if (lines.length <= MAX_TITLE_LINES && widthOk && heightOk) break;
    fontSize -= 2;
  }
  if (lines.length > MAX_TITLE_LINES) lines = lines.slice(0, MAX_TITLE_LINES);

  if (!lines.length) lines = ["BAGIAN INI BIKIN", "PENONTON BERHENTI SCROLL"];
  const textBlockH = estimateTextBlockHeight(lines.length, fontSize);
  const boxH = Math.min(BOX_MAX_HEIGHT, textBlockH + BOX_PADDING_Y * 2);
  const boxBottom = CANVAS_HEIGHT - BOX_BOTTOM_OFFSET;
  const boxY = boxBottom - boxH;
  const firstLineY = boxY + Math.round((boxH - textBlockH) / 2);

  return {
    lines,
    fontSize,
    boxH,
    boxY,
    lineYs: lines.map((_, idx) => firstLineY + (idx * (fontSize + 12)))
  };
}

function normalizeTitleText(value) {
  return String(value || DEFAULT_TITLE_TEXT)
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .slice(0, MAX_TITLE_WORDS)
    .join(" ") || DEFAULT_TITLE_TEXT;
}

function wrapText(value, maxChars, maxLines) {
  const words = String(value || "")
    .split(/\s+/)
    .flatMap((word) => splitLongWord(word, maxChars))
    .filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  const overflow = lines.slice(maxLines - 1).join(" ");
  kept[maxLines - 1] = truncateLine(overflow, maxChars);
  return kept;
}

function splitLongWord(word, maxChars) {
  if (word.length <= maxChars) return [word];
  const chunks = [];
  let remaining = word;
  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars - 1));
    remaining = remaining.slice(maxChars - 1);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function truncateLine(value, maxChars) {
  const cleaned = String(value || "").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function estimateTextWidth(value, fontSize) {
  return String(value || "").length * fontSize * CHAR_WIDTH_RATIO;
}

function estimateTextBlockHeight(lineCount, fontSize) {
  return (lineCount * fontSize) + (Math.max(0, lineCount - 1) * 12);
}

async function resolveFontOption() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.THUMBNAIL_FONT_FILE,
    "C:\\Windows\\Fonts\\BebasNeue-Regular.otf",
    "C:\\Windows\\Fonts\\ARIALNB.TTF",
    "C:\\Windows\\Fonts\\bahnschrift.ttf",
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\segoeuib.ttf",
    home ? path.join(home, ".local/share/fonts/selawik/Selawik-Bold.ttf") : "",
    home ? path.join(home, ".local/share/fonts/selawik/SelawikBold.ttf") : "",
    home ? path.join(home, ".local/share/fonts/selawik/Selawik-Semibold.ttf") : "",
    home ? path.join(home, ".local/share/fonts/selawik/SelawikSemibold.ttf") : "",
    "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
  ].filter(Boolean);

  for (const fontPath of candidates) {
    try {
      await fs.access(fontPath);
      return `fontfile='${escapeFontPath(fontPath)}'`;
    } catch {
      // Try the next installed bold sans font.
    }
  }

  return "font='Selawik Bold'";
}

function escapeFontPath(value) {
  return path.resolve(value)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
}

function probeDurationSeconds(videoPath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath
    ], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const value = parseFloat(stdout.trim());
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

async function pickSeekTimestamp(videoPath) {
  const fallback = "00:00:03";
  const duration = await probeDurationSeconds(videoPath);
  if (!duration) return fallback;
  if (duration <= 2) return formatTimestamp(Math.max(0.1, duration * 0.5));

  const candidates = thumbnailSeekCandidates(duration);
  const measured = [];
  for (const candidate of candidates) {
    const luma = await probeFrameLuma(videoPath, candidate.seconds);
    if (luma !== null) measured.push({ ...candidate, luma });
  }

  const selected = selectThumbnailFrame(measured, THUMBNAIL_MIN_LUMA)
    || candidates[0];
  if (selected?.luma !== undefined) {
    console.log(`Frame thumbnail dipilih pada ${formatTimestamp(selected.seconds)} (luma ${selected.luma.toFixed(1)}).`);
  }
  return formatTimestamp(selected?.seconds ?? duration * 0.5);
}

export function thumbnailSeekCandidates(duration) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 2) return [];
  const margin = Math.min(2, Math.max(0.2, total * 0.06));
  const minSeconds = margin;
  const maxSeconds = Math.max(minSeconds, total - margin);
  const ratios = [0.5, 0.44, 0.56, 0.38, 0.62];
  const seen = new Set();

  return ratios.flatMap((ratio) => {
    const seconds = Math.min(maxSeconds, Math.max(minSeconds, total * ratio));
    const key = seconds.toFixed(3);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ seconds, ratio }];
  });
}

export function selectThumbnailFrame(candidates, minLuma = 28) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const valid = candidates.filter((candidate) => Number.isFinite(candidate?.luma));
  if (valid.length === 0) return null;
  const readable = valid.filter((candidate) => candidate.luma >= minLuma);
  const pool = readable.length > 0 ? readable : valid;

  return [...pool].sort((left, right) => {
    const leftScore = left.luma - Math.abs((left.ratio ?? 0.5) - 0.5) * 12;
    const rightScore = right.luma - Math.abs((right.ratio ?? 0.5) - 0.5) * 12;
    return rightScore - leftScore;
  })[0];
}

function probeFrameLuma(videoPath, seconds) {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "info",
      "-ss", formatTimestamp(seconds),
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", "scale=160:-2,signalstats,metadata=print",
      "-f", "null",
      "-"
    ], { windowsHide: true });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const matches = [...output.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)];
      const value = matches.length > 0 ? Number(matches.at(-1)[1]) : NaN;
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function clampSeconds(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(3, Math.max(0.3, num));
}

function clampDuration(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function clampNumber(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function sanitizeColor(value, fallback) {
  const cleaned = String(value || "").trim();
  return /^0x[0-9a-f]{6}$/i.test(cleaned) ? cleaned : fallback;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function clampOpacity(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}
