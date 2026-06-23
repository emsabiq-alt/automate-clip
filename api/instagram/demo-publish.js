import { boolEnv, methodAllowed, readBody, readStateFile, requireAuth, sendJson, uploadStateFile } from "../_utils.js";
import { stripCaptionSourceCredit } from "../../src/caption-policy.js";
import { publishReel } from "../../src/instagram.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  if (!requireAuth(req, res)) return;

  let jobs = [];
  let jobId = "";
  try {
    if (!boolEnv("INSTAGRAM_UPLOAD_ENABLED", true)) throw new Error("INSTAGRAM_UPLOAD_ENABLED=false.");
    const body = await readBody(req);
    jobId = String(body.job_id || "").trim();
    jobs = await readStateFile("jobs.json");
    const job = latestPostedVideoJob(jobs, jobId);
    if (!job) throw new Error("Belum ada video dengan public_video_url untuk demo Instagram.");
    jobId = job.job_id;

    await patchJob(jobs, job.job_id, {
      instagram_status: "processing",
      instagram_error: ""
    });

    const caption = stripCaptionSourceCredit(job.caption || "Clipper Emsa Pro Instagram video", {
      sourceUrl: job.source_url
    });
    applyInstagramDemoTimeouts();
    const result = await publishReel({
      videoUrl: job.public_video_url,
      caption,
      coverUrl: job.public_thumbnail_url || ""
    });

    const updated = await patchJob(jobs, job.job_id, {
      instagram_status: result?.mediaId ? "published" : "failed",
      instagram_media_id: result?.mediaId || "",
      instagram_container_id: result?.containerId || "",
      instagram_upload_method: result?.uploadMethod || "",
      instagram_error: "",
      publish_status: job.publish_status || "ready"
    });

    sendJson(res, 200, { ok: true, job_id: job.job_id, result, job: updated });
  } catch (error) {
    if (jobId && jobs.length) {
      await patchJob(jobs, jobId, {
        instagram_status: "failed",
        instagram_error: error.message
      }).catch(() => {});
    }
    sendJson(res, 400, { error: error.message, apiCode: error.apiCode || "" });
  }
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

async function patchJob(jobs, jobId, patch) {
  const index = jobs.findIndex((job) => job.job_id === jobId);
  if (index === -1) throw new Error("Job tidak ditemukan.");
  jobs[index] = {
    ...jobs[index],
    ...patch,
    updated_at: new Date().toISOString()
  };
  await uploadStateFile("jobs.json", jobs);
  return jobs[index];
}

function applyInstagramDemoTimeouts() {
  process.env.INSTAGRAM_CONTAINER_POLL_SECONDS ||= process.env.INSTAGRAM_DEMO_CONTAINER_POLL_SECONDS || "4";
  process.env.INSTAGRAM_CONTAINER_MAX_ATTEMPTS ||= process.env.INSTAGRAM_DEMO_CONTAINER_MAX_ATTEMPTS || "12";
  process.env.INSTAGRAM_VIDEO_URL_CHECK_ATTEMPTS ||= process.env.INSTAGRAM_DEMO_VIDEO_URL_CHECK_ATTEMPTS || "4";
  process.env.INSTAGRAM_VIDEO_URL_CHECK_DELAY_SECONDS ||= process.env.INSTAGRAM_DEMO_VIDEO_URL_CHECK_DELAY_SECONDS || "3";
}
