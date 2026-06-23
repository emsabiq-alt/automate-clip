import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { appendHistory } from "./history.js";
import { publishReel } from "./instagram.js";
import { publishToFacebook } from "./facebook.js";
import { appendLog } from "./logger.js";
import { patchItem, readJson, writeJson } from "./storage.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { buildYoutubeMetadata, isYoutubeQuotaError, publishToYoutube, setYoutubeThumbnail } from "./youtube-publisher.js";
import { publishToTikTok } from "./tiktok.js";
import { publishToThreads } from "./threads.js";
import { stripCaptionSourceCredit } from "./caption-policy.js";
import { clearYoutubeQuotaExceeded, markYoutubeQuotaExceeded, youtubeQuotaCooldown } from "./youtube-quota.js";
import { writeJobDiagnostic } from "./diagnostics.js";
import { enabledPublishPlatformsFromConfig, selectPublishPlatforms } from "./publish-mode.js";
import { prepareFacebookCover, prepareInstagramCover } from "./instagram-video.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function latestReadyJob(jobs, selectedPlatforms = enabledPublishPlatformsFromConfig(config)) {
  const retryableStatuses = new Set([
    "ready_to_publish",
    "publish_failed",
    "failed_publish",
    "published_with_warnings",
    "quota_exceeded",
    "published"
  ]);

  return jobs
    .filter((job) => {
      const needsPlatform = [
        selectedPlatforms.youtube && !job.youtube_url && !job.youtube_video_id,
        selectedPlatforms.facebook && !job.facebook_video_id && !job.facebook_post_id,
        selectedPlatforms.instagram && !job.instagram_media_id,
        selectedPlatforms.tiktok && !job.tiktok_publish_id,
        selectedPlatforms.threads && !job.threads_media_id
      ].some(Boolean);
      if (!needsPlatform) return false;
      return [job.status, job.publish_status, job.youtube_status]
        .some((status) => retryableStatuses.has(status));
    })
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0] || null;
}

async function patchVideo(videoId, patch) {
  const videos = await readJson("videos", []);
  const index = videos.findIndex((video) => video.id === videoId);
  if (index === -1) return null;
  videos[index] = { ...videos[index], ...patch, updated_at: new Date().toISOString() };
  await writeJson("videos", videos);
  return videos[index];
}

async function resolveThumbnailPath(job) {
  const thumbnailPath = job.thumbnail_path || "";
  if (thumbnailPath) {
    try {
      const stat = await fs.stat(thumbnailPath);
      if (stat.size) return thumbnailPath;
    } catch {
      // Fall back to the public remote URL when the local generated file is gone.
    }
  }

  if (!job.public_thumbnail_url) return thumbnailPath;

  try {
    await fs.mkdir(config.thumbnailDir, { recursive: true });
    const target = path.join(config.thumbnailDir, `${job.job_id}-youtube-thumbnail.jpg`);
    const response = await fetch(job.public_thumbnail_url);
    if (!response.ok) return thumbnailPath;
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(target, buffer);
    return target;
  } catch {
    return thumbnailPath;
  }
}

async function resolveVideoPath(job, options = {}) {
  const videoPath = job.final_video_path || "";
  if (videoPath) {
    try {
      const stat = await fs.stat(videoPath);
      if (stat.size) return videoPath;
    } catch {
      // GitHub runner baru biasanya tidak punya file lokal; ambil lagi dari public URL remote.
    }
  }

  if (!job.public_video_url) return videoPath;

  await fs.mkdir(path.join(config.generatedDir, "ready-videos"), { recursive: true });
  const target = path.join(config.generatedDir, "ready-videos", `${job.job_id}.mp4`);
  let response;
  try {
    response = await fetch(job.public_video_url);
  } catch (error) {
    if (options.allowMissingLocal) {
      console.warn(`Download ulang video ready dilewati; lanjut pakai public_video_url: ${error.message}`);
      return videoPath;
    }
    throw error;
  }
  if (!response.ok) {
    if (options.allowMissingLocal) {
      console.warn(`Download ulang video ready dilewati; HTTP ${response.status}, lanjut pakai public_video_url.`);
      return videoPath;
    }
    throw new Error(`Gagal download ulang video ready dari remote storage: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    if (options.allowMissingLocal) {
      console.warn("Download ulang video ready kosong; lanjut pakai public_video_url.");
      return videoPath;
    }
    throw new Error("Video ready dari remote storage kosong.");
  }
  await fs.writeFile(target, buffer);
  return target;
}

function summarizePlatformErrors(errors) {
  return Object.entries(errors)
    .filter(([, message]) => message)
    .map(([platform, message]) => `${platform}: ${message}`)
    .join("; ");
}

function readyPlatformStatus({ result, enabled, error, quotaExceeded = false, successStatus = "published" }) {
  if (result) return successStatus;
  if (!enabled) return "disabled";
  if (quotaExceeded) return "quota_exceeded";
  if (error) return "failed";
  return "skipped";
}

async function publishReadyPlatform(name, jobId, errors, quotaExceeded, callback) {
  try {
    return await callback();
  } catch (error) {
    errors[name] = error.message;
    if (name === "youtube" && isYoutubeQuotaError(error)) {
      quotaExceeded.youtube = true;
    }
    await appendLog("platform_publish_failed", {
      job_id: jobId,
      platform: name,
      error: error.message,
      quota_exceeded: name === "youtube" && isYoutubeQuotaError(error)
    });
    console.warn(`${name} publish gagal, workflow lanjut: ${error.message}`);
    return null;
  }
}

function publishReadyDecisionFromConfig() {
  return selectPublishPlatforms(enabledPublishPlatformsFromConfig(config), config.safePublishMode);
}

async function appendSafePublishModeSkips(jobId, publishDecision) {
  for (const [platform, mode] of Object.entries(publishDecision.skippedBySafeMode || {})) {
    await appendLog("safe_publish_mode_skip", {
      job_id: jobId,
      platform,
      mode
    });
    console.warn(`${platform} publish dilewati karena SAFE_PUBLISH_MODE=${mode}.`);
  }
}

const jobId = argValue("--job", "");
const forceYoutube = process.argv.includes("--force-youtube");
const onlyYoutubeThumbnail = process.argv.includes("--only-youtube-thumbnail");
const forceThumbnail = onlyYoutubeThumbnail || process.argv.includes("--force-thumbnail") || process.argv.includes("--set-youtube-thumbnail");
const publishDecision = publishReadyDecisionFromConfig();

await downloadStateFromRemote().catch((error) => {
  console.warn(`State remote dilewati: ${error.message}`);
});

const jobs = await readJson("jobs", []);
const job = jobId ? jobs.find((item) => item.job_id === jobId) : latestReadyJob(jobs, publishDecision.platforms);

if (!job) {
  console.error("Tidak ada job ready_to_publish.");
  process.exit(1);
}

if (!job.final_video_path && !job.public_video_url) {
  console.error(`Job ${job.job_id} tidak punya final_video_path/public_video_url.`);
  process.exit(1);
}

if (publishDecision.mode !== "all" && !publishDecision.hasSelectedPlatform) {
  await appendSafePublishModeSkips(job.job_id, publishDecision);
  await appendLog("safe_publish_mode_no_platforms", {
    job_id: job.job_id,
    mode: publishDecision.mode
  });
  console.log(JSON.stringify({
    status: "safe_publish_mode_skipped",
    job_id: job.job_id,
    mode: publishDecision.mode
  }, null, 2));
  process.exit(0);
}

if (!config.youtube.enabled && !config.facebook.enabled && !config.instagram.enabled && !config.tiktok.enabled && !config.threads.enabled) {
  console.error("Tidak ada platform aktif. Aktifkan YOUTUBE_UPLOAD_ENABLED, FACEBOOK_UPLOAD_ENABLED, INSTAGRAM_UPLOAD_ENABLED, TIKTOK_UPLOAD_ENABLED, atau THREADS_UPLOAD_ENABLED.");
  process.exit(1);
}

if (onlyYoutubeThumbnail && !publishDecision.platforms.youtube) {
  console.error("YOUTUBE_UPLOAD_ENABLED harus aktif untuk set thumbnail YouTube.");
  process.exit(1);
}

if (onlyYoutubeThumbnail && !job.youtube_video_id) {
  console.error(`Job ${job.job_id} belum punya youtube_video_id.`);
  process.exit(1);
}

await patchItem("jobs", job.job_id, onlyYoutubeThumbnail ? {
  youtube_status: "processing",
  youtube_thumbnail_error: ""
} : {
  youtube_status: publishDecision.platforms.youtube && (!job.youtube_url || forceYoutube) ? "processing" : job.youtube_status,
  instagram_status: publishDecision.platforms.instagram && !job.instagram_media_id ? "processing" : job.instagram_status,
  tiktok_status: publishDecision.platforms.tiktok && !job.tiktok_publish_id ? "processing" : job.tiktok_status,
  threads_status: publishDecision.platforms.threads && !job.threads_media_id ? "processing" : job.threads_status,
  publish_status: "publishing",
  status: "publishing"
});

let youtube = (job.youtube_url || job.youtube_video_id) ? {
  videoId: job.youtube_video_id,
  url: job.youtube_url || (job.youtube_video_id ? `https://www.youtube.com/watch?v=${job.youtube_video_id}` : ""),
  customThumbnail: job.youtube_custom_thumbnail === true,
  thumbnailError: job.youtube_thumbnail_error || "",
  skipped: true
} : null;
let instagram = job.instagram_media_id ? {
  mediaId: job.instagram_media_id,
  skipped: true
} : null;
let facebook = (job.facebook_video_id || job.facebook_post_id || job.facebook_url) ? {
  videoId: job.facebook_video_id || "",
  postId: job.facebook_post_id || "",
  url: job.facebook_url || "",
  skipped: true
} : null;
let tiktok = job.tiktok_publish_id ? {
  publishId: job.tiktok_publish_id,
  mode: job.tiktok_mode || "",
  skipped: true
} : null;
let threads = job.threads_media_id ? {
  mediaId: job.threads_media_id,
  url: job.threads_url || "",
  skipped: true
} : null;
const platformErrors = {};
const quotaExceeded = {};

try {
  const thumbnailPath = await resolveThumbnailPath(job);
  const needsLocalVideoPath = Boolean(
    (publishDecision.platforms.youtube && (!youtube || forceYoutube)) ||
    (publishDecision.platforms.tiktok && !tiktok)
  );
  const videoPath = await resolveVideoPath(job, { allowMissingLocal: !needsLocalVideoPath });
  const socialCaption = stripCaptionSourceCredit(job.caption || "", {
    sourceUrl: job.source_url
  });
  const output = {
    title: job.source_title,
    hook: job.source_title,
    finalAbsPath: videoPath,
    caption: socialCaption,
    clipTranscript: job.clipTranscript || "",
    selectedAngle: job.selectedAngle || ""
  };

  await appendSafePublishModeSkips(job.job_id, publishDecision);

  if (!onlyYoutubeThumbnail && publishDecision.platforms.youtube && (!youtube || forceYoutube)) {
    const cooldown = await youtubeQuotaCooldown("upload");
    if (cooldown.active) {
      platformErrors.youtube = `YouTube quota cooldown aktif sampai ${cooldown.until}.`;
      quotaExceeded.youtube = true;
      await appendLog("youtube_quota_cooldown_skip", {
        job_id: job.job_id,
        until: cooldown.until,
        reason: cooldown.reason || ""
      });
      console.warn(`YouTube upload dilewati sampai reset quota: ${cooldown.until}`);
    } else {
      const publishedYoutube = await publishReadyPlatform("youtube", job.job_id, platformErrors, quotaExceeded, async () => {
        const metadata = buildYoutubeMetadata({
          job,
          output,
          caption: socialCaption
        });
        return publishToYoutube({
          videoPath,
          thumbnailPath,
          ...metadata
        });
      });
      if (publishedYoutube) {
        youtube = publishedYoutube;
        await clearYoutubeQuotaExceeded("upload");
      } else if (quotaExceeded.youtube) {
        const quotaState = await markYoutubeQuotaExceeded("upload", platformErrors.youtube);
        if (quotaState.until) {
          console.warn(`YouTube quota cooldown disimpan sampai ${quotaState.until}.`);
        }
      }
    }
  }

  if (
    publishDecision.platforms.youtube
    && youtube?.videoId
    && thumbnailPath
    && (forceThumbnail || (config.youtube.customThumbnailEnabled && youtube.customThumbnail !== true))
  ) {
    const thumbnail = await setYoutubeThumbnail({
      videoId: youtube.videoId,
      thumbnailPath
    });
    youtube = {
      ...youtube,
      customThumbnail: thumbnail.ok,
      thumbnailError: thumbnail.ok ? "" : thumbnail.error
    };
  }

  if (onlyYoutubeThumbnail) {
    const thumbnailOk = youtube?.customThumbnail === true;
    await patchItem("jobs", job.job_id, {
      youtube_status: thumbnailOk ? "published" : "thumbnail_failed",
      youtube_custom_thumbnail: thumbnailOk,
      youtube_thumbnail_error: youtube?.thumbnailError || ""
    });
    await appendLog(thumbnailOk ? "youtube_thumbnail_set" : "youtube_thumbnail_failed", {
      job_id: job.job_id,
      youtube_video_id: youtube?.videoId || "",
      error: youtube?.thumbnailError || ""
    });
    await uploadStateToRemote().catch(() => {});
    console.log(JSON.stringify({
      status: thumbnailOk ? "thumbnail_set" : "thumbnail_failed",
      job_id: job.job_id,
      youtube
    }, null, 2));
    process.exit(thumbnailOk ? 0 : 1);
  }

  if (publishDecision.platforms.instagram && !instagram) {
    const publishedInstagram = await publishReadyPlatform("instagram", job.job_id, platformErrors, quotaExceeded, async () => {
      if (!job.public_video_url) throw new Error("public_video_url kosong, Instagram butuh URL video publik dari remote storage.");
      const instagramCover = videoPath
        ? await prepareInstagramCover({ job, sourcePath: videoPath })
        : { coverPath: "", coverUrl: "" };
      const coverUrl = instagramCover.coverUrl || job.instagram_cover_url || job.public_thumbnail_url || "";
      await patchItem("jobs", job.job_id, {
        instagram_cover_path: instagramCover.coverPath || job.instagram_cover_path || "",
        instagram_cover_url: instagramCover.coverUrl || job.instagram_cover_url || ""
      });
      return publishReel({
        videoUrl: job.public_video_url,
        caption: socialCaption,
        coverUrl
      });
    });
    if (publishedInstagram) instagram = publishedInstagram;
  }

  if (publishDecision.platforms.facebook && !facebook) {
    const publishedFacebook = await publishReadyPlatform("facebook", job.job_id, platformErrors, quotaExceeded, async () => {
      if (!job.public_video_url) throw new Error("public_video_url kosong, Facebook butuh URL video publik dari remote storage.");
      const facebookCover = videoPath
        ? await prepareFacebookCover({ job, sourcePath: videoPath })
        : { coverPath: "", coverUrl: "" };
      await patchItem("jobs", job.job_id, {
        facebook_cover_path: facebookCover.coverPath || job.facebook_cover_path || "",
        facebook_cover_url: facebookCover.coverUrl || job.facebook_cover_url || ""
      });
      return publishToFacebook({
        videoUrl: job.public_video_url,
        videoPath,
        title: job.source_title || "Podcast Clip",
        description: socialCaption,
        thumbnailPath: facebookCover.coverPath || thumbnailPath
      });
    });
    if (publishedFacebook) facebook = publishedFacebook;
  }

  if (publishDecision.platforms.tiktok && !tiktok) {
    const publishedTikTok = await publishReadyPlatform("tiktok", job.job_id, platformErrors, quotaExceeded, async () => {
      if (!job.public_video_url) throw new Error("public_video_url kosong, TikTok butuh URL video publik dari remote storage.");
      return publishToTikTok({
        videoUrl: job.public_video_url,
        videoPath,
        caption: socialCaption
      });
    });
    if (publishedTikTok) tiktok = publishedTikTok;
  }

  if (publishDecision.platforms.threads && !threads) {
    const publishedThreads = await publishReadyPlatform("threads", job.job_id, platformErrors, quotaExceeded, async () => {
      if (!job.public_video_url) throw new Error("public_video_url kosong, Threads butuh URL video publik dari remote storage.");
      return publishToThreads({
        videoUrl: job.public_video_url,
        caption: socialCaption
      });
    });
    if (publishedThreads) threads = publishedThreads;
  }

  if (!youtube && !instagram && !tiktok && !threads) {
    if (quotaExceeded.youtube) {
      await patchItem("jobs", job.job_id, {
        status: "ready_to_publish",
        publish_status: "queued",
        youtube_status: "quota_exceeded",
        youtube_error: platformErrors.youtube || "",
        instagram_status: readyPlatformStatus({
          result: instagram,
          enabled: publishDecision.platforms.instagram,
          error: platformErrors.instagram
        }),
        instagram_error: platformErrors.instagram || "",
        facebook_status: readyPlatformStatus({
          result: facebook,
          enabled: publishDecision.platforms.facebook,
          error: platformErrors.facebook
        }),
        facebook_video_id: facebook?.videoId || "",
        facebook_post_id: facebook?.postId || "",
        facebook_url: facebook?.url || "",
        facebook_error: platformErrors.facebook || "",
        tiktok_status: readyPlatformStatus({
          result: tiktok,
          enabled: publishDecision.platforms.tiktok,
          error: platformErrors.tiktok,
          successStatus: "submitted"
        }),
        tiktok_error: platformErrors.tiktok || "",
        threads_status: readyPlatformStatus({
          result: threads,
          enabled: publishDecision.platforms.threads,
          error: platformErrors.threads
        }),
        threads_error: platformErrors.threads || "",
        error_message: summarizePlatformErrors(platformErrors) || "Quota YouTube habis; menunggu queue reguler berikutnya."
      });
      await appendLog("youtube_quota_deferred", {
        job_id: job.job_id,
        error: platformErrors.youtube || ""
      });
      await uploadStateToRemote().catch(() => {});
      console.log(JSON.stringify({
        status: "queued",
        job_id: job.job_id,
        error: platformErrors.youtube || "Quota YouTube habis."
      }, null, 2));
      process.exit(0);
    }

    throw new Error(summarizePlatformErrors(platformErrors) || "Tidak ada publish yang berhasil dijalankan.");
  }

  const now = new Date().toISOString();
  const hasPlatformErrors = Boolean(Object.keys(platformErrors).length);
  await patchItem("jobs", job.job_id, {
    status: "published",
    publish_status: hasPlatformErrors ? "published_with_warnings" : "published",
    youtube_status: readyPlatformStatus({
      result: youtube,
      enabled: publishDecision.platforms.youtube,
      error: platformErrors.youtube,
      quotaExceeded: quotaExceeded.youtube
    }),
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    youtube_custom_thumbnail: youtube?.customThumbnail === true,
    youtube_thumbnail_error: youtube?.thumbnailError || "",
    youtube_error: platformErrors.youtube || "",
    youtube_published_at: youtube?.skipped ? job.youtube_published_at : youtube ? now : "",
    instagram_status: readyPlatformStatus({
      result: instagram,
      enabled: publishDecision.platforms.instagram,
      error: platformErrors.instagram
    }),
    instagram_media_id: instagram?.mediaId || "",
    instagram_error: platformErrors.instagram || "",
    facebook_status: readyPlatformStatus({
      result: facebook,
      enabled: publishDecision.platforms.facebook,
      error: platformErrors.facebook
    }),
    facebook_video_id: facebook?.videoId || "",
    facebook_post_id: facebook?.postId || "",
    facebook_url: facebook?.url || "",
    facebook_error: platformErrors.facebook || "",
    tiktok_status: readyPlatformStatus({
      result: tiktok,
      enabled: publishDecision.platforms.tiktok,
      error: platformErrors.tiktok,
      successStatus: "submitted"
    }),
    tiktok_publish_id: tiktok?.publishId || "",
    tiktok_mode: tiktok?.mode || "",
    tiktok_error: platformErrors.tiktok || "",
    threads_status: readyPlatformStatus({
      result: threads,
      enabled: publishDecision.platforms.threads,
      error: platformErrors.threads
    }),
    threads_media_id: threads?.mediaId || "",
    threads_url: threads?.url || "",
    threads_error: platformErrors.threads || "",
    error_message: hasPlatformErrors ? summarizePlatformErrors(platformErrors) : "",
    published_at: now
  });
  await patchVideo(job.video_id, {
    status: "published",
    youtube_video_id: youtube?.videoId || job.youtube_video_id,
    youtube_url: youtube?.url || job.youtube_url,
    instagram_media_id: instagram?.mediaId || job.instagram_media_id,
    facebook_video_id: facebook?.videoId || job.facebook_video_id,
    facebook_url: facebook?.url || job.facebook_url,
    tiktok_publish_id: tiktok?.publishId || job.tiktok_publish_id,
    threads_media_id: threads?.mediaId || job.threads_media_id,
    threads_url: threads?.url || job.threads_url
  });
  await appendHistory({
    job_id: job.job_id,
    video_id: job.video_id,
    source_url: job.source_url,
    youtube_video_id: job.youtube_video_id,
    theme: job.theme,
    status: "published",
    final_video_path: job.final_video_path,
    public_video_url: job.public_video_url || "",
    public_thumbnail_url: job.public_thumbnail_url || "",
    caption: socialCaption,
    instagram_media_id: instagram?.mediaId || "",
    facebook_video_id: facebook?.videoId || "",
    facebook_post_id: facebook?.postId || "",
    facebook_url: facebook?.url || "",
    tiktok_publish_id: tiktok?.publishId || "",
    tiktok_mode: tiktok?.mode || "",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    threads_media_id: threads?.mediaId || "",
    threads_url: threads?.url || "",
    published_at: now
  });
  await appendLog(hasPlatformErrors ? "platform_published_with_warnings" : "platform_published", {
    job_id: job.job_id,
    instagram_media_id: instagram?.mediaId || "",
    facebook_video_id: facebook?.videoId || "",
    facebook_post_id: facebook?.postId || "",
    facebook_url: facebook?.url || "",
    tiktok_publish_id: tiktok?.publishId || "",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    threads_media_id: threads?.mediaId || "",
    errors: platformErrors
  });
  await uploadStateToRemote().catch(() => {});
  console.log(JSON.stringify({
    status: hasPlatformErrors ? "published_with_warnings" : "published",
    job_id: job.job_id,
    instagram,
    facebook,
    tiktok,
    youtube,
    threads,
    errors: platformErrors
  }, null, 2));
} catch (error) {
  const hasYoutube = Boolean(youtube?.url || youtube?.videoId || job.youtube_url || job.youtube_video_id);
  const hasFacebook = Boolean(facebook?.videoId || facebook?.postId || facebook?.url || job.facebook_video_id || job.facebook_post_id || job.facebook_url);
  const hasTikTok = Boolean(tiktok?.publishId || job.tiktok_publish_id);
  const hasThreads = Boolean(threads?.mediaId || job.threads_media_id);
  if (isYoutubeQuotaError(error)) {
    await patchItem("jobs", job.job_id, {
      status: "ready_to_publish",
      publish_status: "queued",
      youtube_status: hasYoutube ? "published" : "quota_exceeded",
      youtube_video_id: youtube?.videoId || job.youtube_video_id || "",
      youtube_url: youtube?.url || job.youtube_url || "",
      error_message: "Quota YouTube habis; menunggu queue reguler berikutnya."
    });
    await appendLog("youtube_quota_exceeded", {
      job_id: job.job_id,
      error: error.message
    });
    await uploadStateToRemote().catch(() => {});
    console.log(JSON.stringify({
      status: "queued",
      job_id: job.job_id,
      error: error.message
    }, null, 2));
    process.exit(0);
  }
  await patchItem("jobs", job.job_id, {
    status: "failed_publish",
    publish_status: "failed_publish",
    youtube_status: hasYoutube ? "published" : publishDecision.platforms.youtube ? "failed" : job.youtube_status,
    youtube_video_id: youtube?.videoId || job.youtube_video_id || "",
    youtube_url: youtube?.url || job.youtube_url || "",
    instagram_status: publishDecision.platforms.instagram ? "failed" : job.instagram_status,
    facebook_status: hasFacebook ? "published" : publishDecision.platforms.facebook ? "failed" : job.facebook_status,
    facebook_video_id: facebook?.videoId || job.facebook_video_id || "",
    facebook_post_id: facebook?.postId || job.facebook_post_id || "",
    facebook_url: facebook?.url || job.facebook_url || "",
    tiktok_status: hasTikTok ? "submitted" : publishDecision.platforms.tiktok ? "failed" : job.tiktok_status,
    tiktok_publish_id: tiktok?.publishId || job.tiktok_publish_id || "",
    threads_status: hasThreads ? "published" : publishDecision.platforms.threads ? "failed" : job.threads_status,
    threads_media_id: threads?.mediaId || job.threads_media_id || "",
    threads_url: threads?.url || job.threads_url || "",
    error_message: error.message
  });
  await appendLog("platform_publish_failed", {
    job_id: job.job_id,
    error: error.message
  });
  await writeJobDiagnostic({
    job,
    stage: "publish_ready_failed",
    status: "failed_publish",
    error,
    platformResults: {
      youtube,
      instagram,
      facebook,
      tiktok,
      threads,
      errors: platformErrors,
      quotaExceeded
    }
  });
  await uploadStateToRemote().catch(() => {});
  throw error;
}
