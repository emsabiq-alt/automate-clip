import { boolEnv, methodAllowed, readStateFile, requireAuth, sendJson } from "../_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET"])) return;
  if (!requireAuth(req, res)) return;

  const jobs = await readStateFile("jobs.json");
  const latestJob = latestPostedVideoJob(jobs);
  sendJson(res, 200, {
    configured: Boolean(process.env.INSTAGRAM_IG_USER_ID && process.env.INSTAGRAM_ACCESS_TOKEN),
    uploadEnabled: boolEnv("INSTAGRAM_UPLOAD_ENABLED", true),
    uploadMethod: process.env.INSTAGRAM_REEL_UPLOAD_METHOD || "video_url",
    latestJob: latestJob ? summarizeDemoJob(latestJob) : null
  });
}

function latestPostedVideoJob(jobs = [], jobId = "") {
  if (jobId) return jobs.find((job) => job.job_id === jobId && job.public_video_url) || null;
  return [...jobs]
    .filter((job) => job.public_video_url)
    .sort((a, b) => {
      const left = String(a.updated_at || a.published_at || a.created_at || "");
      const right = String(b.updated_at || b.published_at || b.created_at || "");
      return right.localeCompare(left);
    })[0] || null;
}

function summarizeDemoJob(job) {
  return {
    job_id: job.job_id,
    title: job.thumbnail_text || job.source_title || job.job_id,
    caption: job.caption || "",
    public_video_url: job.public_video_url,
    public_thumbnail_url: job.public_thumbnail_url || "",
    status: job.instagram_status || "",
    result_id: job.instagram_media_id || "",
    updated_at: job.updated_at || job.published_at || job.created_at || ""
  };
}
