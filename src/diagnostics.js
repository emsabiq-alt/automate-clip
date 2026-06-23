import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const platformNames = ["youtube", "instagram", "facebook", "tiktok", "threads"];

function safeSegment(value) {
  return String(value || "workflow")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "workflow";
}

function timestampSegment() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function cleanError(error) {
  return String(error?.message || error || "").slice(0, 2000);
}

function safePath(value) {
  const text = String(value || "");
  if (!text) return "";
  if (/(^|[\\/])\.env($|[\\/])|cookies?\.txt|token/i.test(text)) return "";
  return text;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined && item !== null && item !== "")
  );
}

function platformStatusFromJob(job = {}) {
  return compactObject(Object.fromEntries(
    platformNames.map((name) => [name, job[`${name}_status`] || ""])
  ));
}

function platformStatusFromResults(results = {}) {
  return compactObject(Object.fromEntries(platformNames.map((name) => {
    if (results[name]) return [name, "published"];
    if (results.dailyLimitReached?.[name]) return [name, "daily_limit_reached"];
    if (results.quotaExceeded?.[name]) return [name, "quota_exceeded"];
    if (results.errors?.[name]) return [name, "failed"];
    return [name, ""];
  })));
}

function summarizePreflight(preflight) {
  if (!preflight) return null;
  return {
    ok: Boolean(preflight.ok),
    online: Boolean(preflight.online),
    checks: (preflight.checks || []).map((check) => ({
      name: check.name,
      ok: Boolean(check.ok),
      required: Boolean(check.required),
      detail: String(check.detail || "").slice(0, 500)
    }))
  };
}

function relevantPaths({ job = {}, output = {}, upload = {}, thumbnail = {}, metadataPath = "" }) {
  return compactObject({
    final_video_path: safePath(output.finalAbsPath || job.final_video_path),
    original_final_video_path: safePath(output.originalFinalAbsPath || job.original_final_video_path),
    transcript_path: safePath(output.transcriptReviewAbsPath || output.subtitleAbsPath || job.transcript_path),
    thumbnail_path: safePath(thumbnail.path || job.thumbnail_path),
    metadata_path: safePath(metadataPath || job.metadata_path),
    public_video_url: upload.videoUrl || job.public_video_url || "",
    public_thumbnail_url: upload.thumbnailUrl || job.public_thumbnail_url || "",
    public_metadata_url: upload.metadataUrl || job.public_metadata_url || ""
  });
}

function modeFlags() {
  return {
    DRY_RUN: Boolean(config.dryRun),
    AUTO_PUBLISH: Boolean(config.autoPublish),
    UPLOAD_DRIVER: config.uploadDriver || "",
    SAFE_PUBLISH_MODE: config.safePublishMode || "all",
    REMOTE_UPLOAD_REQUIRED: Boolean(config.remoteUploadRequired)
  };
}

export async function writeJobDiagnostic({
  job = {},
  video = {},
  stage = "workflow",
  status = "failed",
  error = null,
  platformResults = null,
  output = {},
  upload = {},
  thumbnail = {},
  metadataPath = "",
  preflight = null
} = {}) {
  try {
    await fs.mkdir(config.logDir, { recursive: true });
    const jobId = job.job_id || job.id || "";
    const payload = compactObject({
      job_id: jobId,
      video_id: video.id || job.video_id || "",
      source_url: video.url || video.source_url || job.source_url || "",
      stage,
      status,
      error_message: cleanError(error),
      timestamp: new Date().toISOString(),
      platform_statuses: platformResults ? platformStatusFromResults(platformResults) : platformStatusFromJob(job),
      relevant_file_paths: relevantPaths({ job, output, upload, thumbnail, metadataPath }),
      preflight_summary: summarizePreflight(preflight),
      node_version: process.version,
      platform: process.platform,
      cwd: process.cwd(),
      environment_mode_flags: modeFlags()
    });
    const file = path.join(config.logDir, `${safeSegment(jobId)}-${safeSegment(stage)}-${timestampSegment()}.diagnostic.json`);
    await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return file;
  } catch (diagnosticError) {
    console.warn(`Diagnostic log dilewati: ${diagnosticError.message}`);
    return null;
  }
}
