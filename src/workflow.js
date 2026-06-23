import fs from "node:fs/promises";
import path from "node:path";
import { config, canPublish, shouldUploadToRemote } from "./config.js";
import { ensureProjectDirs, patchItem, saveGeneratedJson } from "./storage.js";
import { appendLog } from "./logger.js";
import { appendHistory, publishedCountToday, queueSeriesSuccessCount, youtubePublishedCountToday } from "./history.js";
import { addVideo, createJobRecord, selectNextVideo, updateVideoStatus } from "./selector.js";
import { runClipper } from "./clipper-runner.js";
import { generateCaption, generateFrameQuoteText, generateThumbnailText } from "./caption.js";
import { stripCaptionSourceCredit } from "./caption-policy.js";
import { generateThumbnail, prependThumbnailIntro } from "./thumbnail.js";
import { fileExists, uploadHistoryFile, uploadJobFiles, validatePublicUrl } from "./uploader.js";
import { publishReel } from "./instagram.js";
import { prepareFacebookCover, prepareInstagramCover, prepareInstagramVideo } from "./instagram-video.js";
import { publishToFacebook } from "./facebook.js";
import { buildYoutubeMetadata, isYoutubeQuotaError, publishToYoutube } from "./youtube-publisher.js";
import { publishToTikTok } from "./tiktok.js";
import { publishToThreads } from "./threads.js";
import { todayDate } from "./job-id.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { clearYoutubeQuotaExceeded, markYoutubeQuotaExceeded, youtubeQuotaCooldown } from "./youtube-quota.js";
import { assertPreflightOk, printPreflightReport, runPreflight } from "./preflight.js";
import { discoverAndQueueVideos } from "./video-discovery.js";
import { applyVideoEffects } from "./video-effects.js";
import { writeJobDiagnostic } from "./diagnostics.js";
import { enabledPublishPlatformsFromConfig, selectPublishPlatforms } from "./publish-mode.js";
import { metaInterClipDelayMs, waitForMetaInterClipDelay } from "./platform-delay.js";
import {
  isAutomationSeriesVideo,
  queueSeriesTarget,
  scheduledClipsPerRun,
  seriesClipsForRun,
  dedupeClipRanges,
  storedSeriesClipRanges
} from "./queue-policy.js";

export async function runWorkflow(options = {}) {
  await ensureProjectDirs();

  const preflightPublishDecision = publishDecisionFromConfig();
  const publishRequested = Boolean(options.publish && canPublish());
  const anyPublishSelected = publishRequested && (
    preflightPublishDecision.mode === "all" || preflightPublishDecision.hasSelectedPlatform
  );
  const youtubePublishRequired = publishRequested && (
    preflightPublishDecision.mode === "all" || preflightPublishDecision.platforms.youtube
  );
  const preflight = await runPreflight({
    publishRequired: youtubePublishRequired,
    socialPublishRequired: false,
    socialOnline: anyPublishSelected,
    deepgramOnline: false
  });
  printPreflightReport(preflight);
  try {
    assertPreflightOk(preflight);
  } catch (error) {
    await appendLog("precheck_failed", { error: error.message });
    throw error;
  }

  const remoteCheck = preflight.checks.find((check) => check.name === config.ftp.label);
  if (remoteCheck && !remoteCheck.ok && !remoteCheck.required) {
    // Jangan matikan media upload di sini. SFTP sering hanya timeout sesaat saat
    // preflight (menit awal) tapi pulih saat upload sesungguhnya terjadi (setelah
    // clipper, ~menit ke-20). Upload punya retry sendiri; biarkan dicoba di
    // waktu naturalnya. State sync juga tetap dicoba dengan merge.
    await appendLog("remote_preflight_warning", {
      driver: config.uploadDriver,
      reason: remoteCheck.detail || "remote storage preflight failed"
    });
    console.warn(`${config.ftp.label} preflight warning; upload & state sync tetap dicoba dengan retry/merge.`);
  }

  await downloadStateFromRemote().catch((error) => {
    console.warn(`State remote dilewati: ${error.message}`);
  });

  let scheduledDailyLimit = 0;
  let scheduledPostedToday = 0;

  if (options.scheduled && options.publish) {
    scheduledDailyLimit = Math.max(0, Number(process.env.MAX_SCHEDULED_POSTS_PER_DAY) || 0);
    scheduledPostedToday = scheduledDailyLimit > 0 ? await publishedCountToday() : 0;
    if (scheduledDailyLimit > 0 && scheduledPostedToday >= scheduledDailyLimit) {
      await appendLog("scheduled_skip", {
        reason: "daily_limit_reached",
        posted_today: scheduledPostedToday,
        daily_limit: scheduledDailyLimit
      });
      return {
        status: "scheduled_skip",
        reason: "daily_limit_reached",
        posted_today: scheduledPostedToday,
        daily_limit: scheduledDailyLimit
      };
    }
  }

  let discoveryResult = null;
  const keepVideoQueued = false;

  if (options.url) {
    const selection = await createManualSelection(options);
    if (!selection) {
      return noVideoSelectedResult({ discoveryResult, failedSelections: [] });
    }
    return processSelectedWorkflow({
      selection,
      options,
      scheduledDailyLimit,
      scheduledPostedToday,
      keepVideoQueued: false,
      preflight
    });
  }

  discoveryResult = await discoverQueuedVideos(options);
  let discoveredVideoIds = (discoveryResult?.added || [])
    .map((video) => video.id)
    .filter(Boolean);
  if (options.scheduled) discoveredVideoIds = [];
  let recoveryDiscoveryAttempted = false;
  const failedSelections = [];
  const excludedVideoIds = new Set();
  const maxAttempts = queueFailoverLimit();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let selection = await selectQueuedWorkflowVideo({
      options,
      excludedVideoIds,
      preferredVideoIds: discoveredVideoIds
    });

    if (!selection && !recoveryDiscoveryAttempted) {
      recoveryDiscoveryAttempted = true;
      const recoveryDiscoveryResult = await discoverQueuedVideos(options);
      discoveryResult = mergeDiscoveryResults(discoveryResult, recoveryDiscoveryResult);
      discoveredVideoIds = (discoveryResult?.added || [])
        .map((video) => video.id)
        .filter(Boolean);
      if (options.scheduled) discoveredVideoIds = [];

      if (discoveredVideoIds.length) {
        selection = await selectQueuedWorkflowVideo({
          options,
          excludedVideoIds,
          preferredVideoIds: discoveredVideoIds
        });
      }

      if (!selection) {
        selection = await selectQueuedWorkflowVideo({ options, excludedVideoIds });
      }
    }

    if (!selection) {
      return noVideoSelectedResult({ discoveryResult, failedSelections });
    }

    try {
      const result = await processSelectedWorkflow({
        selection,
        options,
        scheduledDailyLimit,
        scheduledPostedToday,
        keepVideoQueued,
        preflight
      });
      if (failedSelections.length) {
        return {
          ...result,
          skipped_failed_video_count: failedSelections.length,
          skipped_failed_videos: failedSelections
        };
      }
      return result;
    } catch (error) {
      const failed = summarizeFailedSelection(selection, error);
      failedSelections.push(failed);
      excludedVideoIds.add(selection.video.id);
      await appendLog("queue_video_failed_skip", {
        attempt,
        max_attempts: maxAttempts,
        ...failed
      });
      console.warn(`Video antrean gagal, dilewati: ${error.message}`);
    }
  }

  await uploadStateToRemote().catch(() => {});
  await appendLog("queue_failover_exhausted", {
    failed_video_count: failedSelections.length,
    failed_videos: failedSelections
  });
  return {
    status: "queue_failed",
    failed_video_count: failedSelections.length,
    failed_videos: failedSelections
  };
}

async function createManualSelection(options) {
  const video = await addVideo({
    url: options.url,
    theme: options.theme && options.theme !== "auto" ? options.theme : "podcast artis",
    target_date: todayDate(),
    priority: 0,
    manual_range: options.range || "",
    quality_profile: options.qualityProfile || "standard",
    clip_count: Number(options.clipCount || process.env.CLIP_COUNT || 1),
    scene_mode: options.sceneMode || "podcast",
    subtitle_font: options.subtitleFont || "Segoe UI Semibold",
    subtitle_font_size: options.subtitleFontSize || 56,
    subtitle_margin_v: options.subtitleMarginV || 550,
    subtitle_margin_h: options.subtitleMarginH || Number(process.env.SUBTITLE_MARGIN_H || 80),
    use_frame: options.useFrame,
    use_filter: options.useFilter,
    use_watermark: options.useWatermark,
    use_music: options.useMusic,
    use_subtitle_highlight: options.useSubtitleHighlight,
    force_reprocess: options.forceReprocess === true,
    automation_series: false,
    manual_run: true,
    notes: "Ditambahkan dari CLI/manual run"
  });
  return selectNextVideo({
    theme: video.theme,
    targetDate: todayDate(),
    preferredVideoIds: [video.id],
    forceReprocess: options.forceReprocess === true
  });
}

function queueFailoverLimit() {
  const configured = Number(process.env.QUEUE_FAILOVER_ATTEMPTS || process.env.AUTOMATION_QUEUE_LINK_LIMIT || 5);
  if (!Number.isFinite(configured) || configured <= 0) return 15;
  return Math.min(Math.floor(configured), 50);
}

function summarizeFailedSelection(selection, error) {
  return {
    video_id: selection?.video?.id || "",
    youtube_video_id: selection?.video?.youtube_video_id || "",
    url: selection?.video?.url || selection?.video?.source_url || "",
    error: error.message
  };
}

async function selectQueuedWorkflowVideo({ options, excludedVideoIds, preferredVideoIds = [] }) {
  return selectNextVideo({
    theme: options.theme || config.defaultTheme,
    preferredVideoIds,
    excludeVideoIds: [...excludedVideoIds],
    forceReprocess: options.forceReprocess === true,
    randomize: options.scheduled !== true,
    seriesMode: options.scheduled === true,
    excludeAutomationSeries: options.scheduled !== true
  });
}

async function discoverQueuedVideos(options) {
  try {
    const discoveryResult = await discoverAndQueueVideos({
      theme: options.theme || config.defaultTheme,
      targetDate: todayDate(),
      automationSeries: options.scheduled === true,
      manualRun: options.scheduled !== true,
      ignoreDailyQueueLimit: options.scheduled !== true
    });
    await appendLog("discovery_result", {
      skipped: Boolean(discoveryResult?.skipped),
      reason: discoveryResult?.reason || "",
      added_count: discoveryResult?.added?.length || 0,
      expired_count: discoveryResult?.expired_count || 0,
      daily_queue_count: discoveryResult?.daily_queue_count || 0,
      daily_queue_limit: discoveryResult?.daily_queue_limit || 0,
      added_video_ids: (discoveryResult?.added || []).map((video) => video.id)
    });
    return discoveryResult;
  } catch (error) {
    console.warn(`Auto discovery gagal, fallback ke antrean lama: ${error.message}`);
    await appendLog("discovery_failed", { error: error.message });
    return null;
  }
}

function mergeDiscoveryResults(previous, next) {
  if (!previous) return next || null;
  if (!next) return previous;
  return {
    ...next,
    added: [
      ...(previous.added || []),
      ...(next.added || [])
    ],
    expired_count: (previous.expired_count || 0) + (next.expired_count || 0),
    daily_queue_count: next.daily_queue_count || previous.daily_queue_count || 0,
    daily_queue_limit: next.daily_queue_limit || previous.daily_queue_limit || 0,
    skipped: Boolean(previous.skipped && next.skipped),
    reason: next.reason || previous.reason || ""
  };
}

async function noVideoSelectedResult({ discoveryResult, failedSelections }) {
  await appendLog("no_video_selected", {
    discovery_added_count: discoveryResult?.added?.length || 0,
    discovery_skipped: Boolean(discoveryResult?.skipped),
    discovery_reason: discoveryResult?.reason || "",
    discovery_expired_count: discoveryResult?.expired_count || 0,
    daily_queue_count: discoveryResult?.daily_queue_count || 0,
    daily_queue_limit: discoveryResult?.daily_queue_limit || 0,
    skipped_failed_video_count: failedSelections.length
  });
  await uploadStateToRemote().catch(() => {});
  return {
    status: "no_video_selected",
    discovery_added_count: discoveryResult?.added?.length || 0,
    discovery_skipped: Boolean(discoveryResult?.skipped),
    discovery_reason: discoveryResult?.reason || "",
    discovery_expired_count: discoveryResult?.expired_count || 0,
    daily_queue_count: discoveryResult?.daily_queue_count || 0,
    daily_queue_limit: discoveryResult?.daily_queue_limit || 0,
    skipped_failed_video_count: failedSelections.length,
    skipped_failed_videos: failedSelections
  };
}

async function processSelectedWorkflow({ selection, options, scheduledDailyLimit, scheduledPostedToday, keepVideoQueued = false, preflight = null }) {
  const baseVideo = options.useSubtitleHighlight === true
    ? { ...selection.video, use_subtitle_highlight: true }
    : { ...selection.video };

  // Untuk link series terjadwal: render seluruh sisa klip dalam SATU proses clipper.
  // Satu proses menjamin klip tidak saling tumpang tindih (anti-duplikat kokoh),
  // dan link selesai dalam satu run sehingga tidak bergantung pada sinkronisasi
  // state antar-run yang rawan gagal. Dibatasi juga oleh sisa slot harian agar
  // tidak merender klip yang akan dibuang oleh MAX_SCHEDULED_POSTS_PER_DAY.
  const isSeriesRun = options.scheduled === true && isAutomationSeriesVideo(baseVideo);
  let seriesClipTarget = isSeriesRun ? seriesClipsForRun(baseVideo) : 0;
  if (isSeriesRun && options.publish && scheduledDailyLimit > 0) {
    const remainingDailySlots = Math.max(0, scheduledDailyLimit - scheduledPostedToday);
    seriesClipTarget = Math.min(seriesClipTarget, remainingDailySlots);
  }
  if (isSeriesRun && seriesClipTarget > 0) {
    baseVideo.clip_count = seriesClipTarget;
  }

  const { theme, prompt } = selection;
  const video = baseVideo;
  selection = { ...selection, video };
  const job = await createJobRecord(selection, { keepVideoStatus: keepVideoQueued });
  const maybeUpdateVideoStatus = async (status, patch) => {
    if (keepVideoQueued) return;
    await updateVideoStatus(video.id, status, patch);
  };
  await appendLog("job_created", {
    job_id: job.job_id,
    video_id: video.id,
    url: video.url,
    keep_video_queued: keepVideoQueued
  });

  try {
    await updateJob(job.job_id, {
      status: "clipper_processing",
      clipper_status: "processing"
    });
    await maybeUpdateVideoStatus("clipper_processing");

    const clipperResult = await runClipper({
      video,
      job,
      onLog: (message) => {
        if (message) console.log(message);
      }
    });

    const allOutputs = clipperResult.outputs.filter((output) => output?.finalAbsPath);
    if (!allOutputs.length) {
      throw new Error("Clipper tidak menghasilkan file MP4 final.");
    }

    // Series run: proses semua klip yang dirender (sudah dibatasi clip_count = sisa target).
    // Non-series scheduled run tetap pakai SCHEDULED_CLIPS_PER_RUN.
    const perRunClipLimit = options.scheduled
      ? (isSeriesRun ? allOutputs.length : scheduledClipsPerRun())
      : allOutputs.length;
    const remainingScheduledSlots = options.scheduled && options.publish && scheduledDailyLimit > 0
      ? Math.min(perRunClipLimit, Math.max(0, scheduledDailyLimit - scheduledPostedToday))
      : perRunClipLimit;
    const outputs = allOutputs.slice(0, remainingScheduledSlots);

    if (allOutputs.length > outputs.length) {
      await appendLog("scheduled_clip_cap", {
        job_id: job.job_id,
        generated_clip_count: allOutputs.length,
        processed_clip_count: outputs.length,
        posted_today: scheduledPostedToday,
        daily_limit: scheduledDailyLimit
      });
      console.log(
        `Scheduled daily cap: proses ${outputs.length}/${allOutputs.length} clip ` +
          `(posted today ${scheduledPostedToday}/${scheduledDailyLimit}).`
      );
    }

    if (!outputs.length) throw new Error("Tidak ada slot publish tersisa untuk jadwal hari ini.");

    for (const output of outputs) {
      if (!await fileExists(output.finalAbsPath)) {
        throw new Error(`Clipper output tidak ditemukan: ${output.finalAbsPath}`);
      }
    }

    await updateJob(job.job_id, {
      status: "clipper_done",
      clipper_status: "done",
      source_title: outputs[0]?.title || "",
      final_video_path: outputs[0]?.finalAbsPath || "",
      transcript_path: outputs[0]?.transcriptReviewAbsPath || outputs[0]?.subtitleAbsPath || "",
      clip_total: outputs.length
    });

    const clipResults = [];
    for (const [index, output] of outputs.entries()) {
      await updateJob(job.job_id, {
        status: "clip_processing",
        current_clip_index: index + 1,
        clip_total: outputs.length
      });

      try {
        const result = await processClipOutput({
          job,
          video,
          theme,
          prompt,
          output,
          clipperResult,
          index,
          total: outputs.length,
          options
        });
        clipResults.push(result);
      } catch (error) {
        const failed = {
          ok: false,
          clipIndex: index + 1,
          clipJobId: buildClipStorageJob(job, index, outputs.length).job_id,
          error: error.message
        };
        clipResults.push(failed);
        await writeJobDiagnostic({
          job: { ...job, job_id: failed.clipJobId },
          video,
          stage: "clip_failed",
          status: "failed",
          error,
          output,
          preflight
        });
        await appendLog("clip_failed", {
          job_id: job.job_id,
          clip_index: index + 1,
          error: error.message
        });
        console.warn(`Clip ${index + 1}/${outputs.length} gagal, lanjut clip berikutnya: ${error.message}`);
      }

      await updateJob(job.job_id, {
        clip_results: clipResults.map(summarizeClipResult)
      });
    }

    if (!clipResults.some((item) => item.ok)) {
      throw new Error(clipResults.map((item) => item.error).filter(Boolean).join("; ") || "Semua clip gagal diproses.");
    }

    const final = finalStatusFromClipResults(clipResults, workflowPublishEnabled(options));
    const firstSuccess = clipResults.find((item) => item.ok);
    const lastPlatformResults = [...clipResults].reverse().find((item) => item.platformResults)?.platformResults || {};
    const seriesPatch = await queueSeriesStatusPatch({ job, video, options, final, clipResults });

    await updateJob(job.job_id, {
      status: final.status,
      publish_status: final.publishStatus,
      successful_clip_count: final.successfulClips,
      failed_clip_count: final.failedClips,
      published_clip_count: final.publishedClips,
      clip_results: clipResults.map(summarizeClipResult),
      final_video_path: firstSuccess?.output?.finalAbsPath || "",
      original_final_video_path: firstSuccess?.output?.originalFinalAbsPath || "",
      video_effects: firstSuccess?.output?.videoEffects || null,
      background_music: firstSuccess?.output?.backgroundMusic || null,
      thumbnail_intro: firstSuccess?.output?.thumbnailIntro || { applied: false },
      frame_quote_text: firstSuccess?.output?.frameQuoteText || "",
      public_video_url: firstSuccess?.upload?.videoUrl || "",
      public_thumbnail_url: firstSuccess?.upload?.thumbnailUrl || "",
      public_metadata_url: firstSuccess?.upload?.metadataUrl || "",
      published_at: final.publishedClips > 0 ? new Date().toISOString() : "",
      series_target_count: seriesPatch.patch?.series_target_count || job.series_target_count || 0,
      series_success_count: seriesPatch.patch?.series_success_count ?? job.series_success_count ?? 0,
      series_remaining_count: seriesPatch.patch?.series_remaining_count ?? 0
    });

    await maybeUpdateVideoStatus(seriesPatch.videoStatus || final.videoStatus, {
      youtube_video_id: lastPlatformResults.youtube?.videoId || video.youtube_video_id,
      youtube_url: lastPlatformResults.youtube?.url || "",
      instagram_media_id: lastPlatformResults.instagram?.mediaId || "",
      facebook_video_id: lastPlatformResults.facebook?.videoId || "",
      facebook_url: lastPlatformResults.facebook?.url || "",
      tiktok_publish_id: lastPlatformResults.tiktok?.publishId || "",
      threads_media_id: lastPlatformResults.threads?.mediaId || "",
      threads_url: lastPlatformResults.threads?.url || "",
      error_message: seriesPatch.errorMessage ?? final.errorMessage,
      ...seriesPatch.patch
    });

    await uploadHistoryIfPossible();
    await uploadStateToRemote().catch(() => {});
    await appendLog(final.event, {
      job_id: job.job_id,
      clip_total: outputs.length,
      successful_clip_count: final.successfulClips,
      failed_clip_count: final.failedClips,
      published_clip_count: final.publishedClips,
      series_success_count: seriesPatch.patch?.series_success_count,
      series_target_count: seriesPatch.patch?.series_target_count
    });

    return {
      status: final.publishStatus,
      job_id: job.job_id,
      clip_total: outputs.length,
      successful_clip_count: final.successfulClips,
      failed_clip_count: final.failedClips,
      published_clip_count: final.publishedClips,
      series_success_count: seriesPatch.patch?.series_success_count,
      series_target_count: seriesPatch.patch?.series_target_count,
      clips: clipResults.map(summarizeClipResult)
    };
  } catch (error) {
    await updateJob(job.job_id, {
      status: "failed",
      error_message: error.message
    });
    await maybeUpdateVideoStatus("failed", { error_message: error.message });
    await writeJobDiagnostic({
      job,
      video,
      stage: "workflow_failed",
      status: "failed",
      error,
      preflight
    });
    await uploadStateToRemote().catch(() => {});
    await appendLog("workflow_failed", { job_id: job.job_id, error: error.message });
    throw error;
  }
}

async function processClipOutput({ job, video, theme, prompt, output, clipperResult, index, total, options }) {
  const clipIndex = index + 1;
  const storageJob = buildClipStorageJob(job, index, total);
  const aiProvider = "openai";
  const thumbnailText = await generateThumbnailText({ job: storageJob, output, promptTemplate: prompt, aiProvider });
  const frameQuoteText = shouldUseLowerThird(video, options)
    ? await generateFrameQuoteText({ job: storageJob, output, promptTemplate: prompt, aiProvider })
    : "";
  output = { ...output, thumbnailText, frameQuoteText };

  const effectsResult = await applyVideoEffects({
    job: storageJob,
    video,
    output,
    options: {
      ...options,
      frameTitle: thumbnailText,
      lowerThirdText: frameQuoteText
    }
  });
  output = { ...effectsResult.output, videoEffects: effectsResult.effects };

  await updateJob(job.job_id, {
    final_video_path: output.finalAbsPath,
    original_final_video_path: output.originalFinalAbsPath || "",
    video_effects: effectsResult.effects,
    frame_quote_text: frameQuoteText
  });

  const generatedCaption = await generateCaption({
    job: storageJob,
    output,
    promptTemplate: prompt,
    clipperRoot: clipperResult.clipperRoot,
    aiProvider
  });
  const caption = stripCaptionSourceCredit(generatedCaption, {
    sourceUrl: video.url || video.source_url
  });
  await updateJob(job.job_id, {
    caption_status: "done",
    caption,
    current_clip_index: clipIndex
  });

  const thumbnail = await generateThumbnail({
    job: storageJob,
    videoPath: output.finalAbsPath,
    text: thumbnailText
  });
  const thumbnailIntro = await prependThumbnailIntro({
    job: storageJob,
    videoPath: output.finalAbsPath,
    thumbnailPath: thumbnail.path,
    text: thumbnail.text
  }).catch((error) => {
    console.warn(`Intro TTS dilewati: ${error.message}`);
    return null;
  });
  if (thumbnailIntro?.path) {
    output = {
      ...output,
      finalAbsPath: thumbnailIntro.path,
      thumbnailIntro: {
        applied: true,
        durationSeconds: thumbnailIntro.durationSeconds,
        introPath: thumbnailIntro.introPath,
        ttsApplied: thumbnailIntro.ttsApplied === true,
        ttsAudioPath: thumbnailIntro.ttsAudioPath || "",
        ttsProvider: thumbnailIntro.ttsProvider || "",
        ttsFallbackFrom: thumbnailIntro.ttsFallbackFrom || "",
        ttsFallbackError: thumbnailIntro.ttsFallbackError || "",
        ttsKeyIndex: thumbnailIntro.ttsKeyIndex || "",
        ttsText: thumbnailIntro.ttsText || "",
        ttsModel: thumbnailIntro.ttsModel || "",
        ttsVoice: thumbnailIntro.ttsVoice || "",
        ttsSpeed: thumbnailIntro.ttsSpeed || "",
        ttsVolume: thumbnailIntro.ttsVolume || "",
        visualMode: thumbnailIntro.visualMode || "",
        transitionApplied: thumbnailIntro.transitionApplied === true,
        transitionPath: thumbnailIntro.transitionPath || "",
        transitionDurationSeconds: thumbnailIntro.transitionDurationSeconds || 0,
        transitionSourceDurationSeconds: thumbnailIntro.transitionSourceDurationSeconds || 0,
        transitionSpeed: thumbnailIntro.transitionSpeed || "",
        transitionKeyColor: thumbnailIntro.transitionKeyColor || "",
        transitionKeySimilarity: thumbnailIntro.transitionKeySimilarity ?? "",
        transitionKeyBlend: thumbnailIntro.transitionKeyBlend ?? ""
      }
    };
  }
  await updateJob(job.job_id, {
    thumbnail_status: "done",
    thumbnail_path: thumbnail.path,
    thumbnail_text: thumbnail.text,
    final_video_path: output.finalAbsPath,
    thumbnail_intro: output.thumbnailIntro || { applied: false }
  });

  const metadata = buildMetadata({
    job: storageJob,
    video,
    theme,
    prompt,
    output,
    clipperResult,
    caption,
    thumbnail,
    clipIndex,
    clipTotal: total,
    videoEffects: effectsResult.effects
  });
  const metadataPath = await saveGeneratedJson("metadata", `${storageJob.job_id}.json`, metadata);

  let upload = {
    videoUrl: "",
    thumbnailUrl: "",
    metadataUrl: ""
  };
  // YouTube tidak butuh public URL (upload file lokal). Semua sosmed butuh.
  // Jadi melanjutkan tanpa public URL hanya masuk akal kalau YouTube memang
  // akan dicoba di run ini. Kalau target hanya sosmed (mis. SAFE_PUBLISH_MODE=
  // social_only atau YouTube kena quota), public URL wajib ada; kalau gagal,
  // lempar error agar klip di-retry, bukan publish kosong.
  const uploadPublishDecision = publishDecisionFromConfig();
  const youtubeWillBeTried = uploadPublishDecision.platforms.youtube === true
    && !(await youtubeQuotaCooldown("upload")).active;
  if (shouldUploadToRemote()) {
    try {
      upload = await uploadJobFiles({
        job: storageJob,
        videoPath: output.finalAbsPath,
        thumbnailPath: thumbnail.path,
        metadataPath
      });
      const videoPublicOk = await validatePublicUrl(upload.videoUrl);
      if (!videoPublicOk) throw new Error(`Public video URL belum valid: ${upload.videoUrl}`);
    } catch (error) {
      if (config.remoteUploadRequired || !youtubeWillBeTried) throw error;
      await appendLog("remote_upload_failed_skip", {
        job_id: storageJob.job_id,
        error: error.message
      });
      console.warn(`${config.ftp.label} upload gagal; lanjut YouTube tanpa public URL: ${error.message}`);
      upload = {
        videoUrl: "",
        thumbnailUrl: "",
        metadataUrl: ""
      };
    }
  }
  console.log(`Public video URL valid clip ${clipIndex}/${total}:`, upload.videoUrl);

  await updateJob(job.job_id, {
    status: "ready_to_publish",
    publish_status: "ready",
    metadata_path: metadataPath,
    public_video_url: upload.videoUrl,
    public_thumbnail_url: upload.thumbnailUrl,
    public_metadata_url: upload.metadataUrl
  });

  const publishDecision = publishDecisionFromConfig();
  const publishEnabled = Boolean(options.publish && canPublish());
  const canAttemptPublish = publishEnabled && (publishDecision.mode === "all" || publishDecision.hasSelectedPlatform);

  if (canAttemptPublish) {
    const platformResults = await publishPlatforms({
      job,
      output,
      caption,
      upload,
      thumbnail,
      publishDecision,
      clipIndex
    });
    const primaryPublished = platformResults.hasAnySuccess;
    const youtubeQuotaExceeded = Boolean(platformResults.quotaExceeded?.youtube);
    const youtubeDailyLimitReached = Boolean(platformResults.dailyLimitReached?.youtube);
    const deferredByYoutube = (youtubeQuotaExceeded || youtubeDailyLimitReached) && !primaryPublished;
    const publishStatus = primaryPublished
      ? platformResults.hasErrors ? "published_with_warnings" : "published"
      : deferredByYoutube ? "queued" : "publish_failed";
    const now = new Date().toISOString();

    await updateJob(job.job_id, {
      status: primaryPublished ? "published" : deferredByYoutube ? "queued" : "ready_to_publish",
      publish_status: publishStatus,
      instagram_status: platformPublishStatus(platformResults, "instagram", config.instagram.enabled),
      instagram_media_id: platformResults.instagram?.mediaId || "",
      instagram_error: platformResults.errors.instagram || "",
      facebook_status: platformPublishStatus(platformResults, "facebook", config.facebook.enabled),
      facebook_video_id: platformResults.facebook?.videoId || "",
      facebook_post_id: platformResults.facebook?.postId || "",
      facebook_url: platformResults.facebook?.url || "",
      facebook_error: platformResults.errors.facebook || "",
      tiktok_status: platformPublishStatus(platformResults, "tiktok", config.tiktok.enabled, "submitted"),
      tiktok_publish_id: platformResults.tiktok?.publishId || "",
      tiktok_mode: platformResults.tiktok?.mode || "",
      tiktok_error: platformResults.errors.tiktok || "",
      threads_status: platformPublishStatus(platformResults, "threads", config.threads.enabled),
      threads_media_id: platformResults.threads?.mediaId || "",
      threads_url: platformResults.threads?.url || "",
      threads_error: platformResults.errors.threads || "",
      youtube_status: platformPublishStatus(platformResults, "youtube", config.youtube.enabled),
      youtube_video_id: platformResults.youtube?.videoId || "",
      youtube_url: platformResults.youtube?.url || "",
      youtube_error: platformResults.errors.youtube || "",
      youtube_custom_thumbnail: platformResults.youtube?.customThumbnail === true,
      youtube_thumbnail_error: platformResults.youtube?.thumbnailError || "",
      youtube_published_at: platformResults.youtube ? now : "",
      published_at: primaryPublished ? now : ""
    });

    await appendHistoryEntry({
      job: storageJob,
      video,
      caption,
      output,
      upload,
      platformResults,
      status: primaryPublished ? "published" : publishStatus,
      clipIndex,
      clipTotal: total,
      options
    });

    return {
      ok: true,
      clipIndex,
      clipJobId: storageJob.job_id,
      output,
      upload,
      caption,
      platformResults,
      primaryPublished,
      publishStatus
    };
  }

  if (publishEnabled) {
    await appendSafePublishModeSkips(job.job_id, publishDecision);
    if (publishDecision.mode !== "all" && !publishDecision.hasSelectedPlatform) {
      await appendLog("safe_publish_mode_no_platforms", {
        job_id: job.job_id,
        mode: publishDecision.mode
      });
      console.warn(`SAFE_PUBLISH_MODE=${publishDecision.mode}; tidak ada platform publish yang dipilih.`);
    }
  }

  const status = options.publish ? "dry_run" : "ready_to_publish";
  await appendHistoryEntry({ job: storageJob, video, caption, output, upload, status, clipIndex, clipTotal: total, options });
  return {
    ok: true,
    clipIndex,
    clipJobId: storageJob.job_id,
    output,
    upload,
    caption,
    platformResults: null,
    primaryPublished: false,
    publishStatus: status
  };
}

function buildClipStorageJob(job, index, total) {
  if (total <= 1) return job;
  return {
    ...job,
    job_id: `${job.job_id}-clip-${String(index + 1).padStart(2, "0")}`
  };
}

function summarizeClipResult(result) {
  const platformResults = result.platformResults || null;
  const errors = platformResults?.errors || {};

  return {
    ok: Boolean(result.ok),
    clip_index: result.clipIndex,
    clip_job_id: result.clipJobId,
    status: result.publishStatus || (result.ok ? "ready" : "failed"),
    error: result.error || "",
    public_video_url: result.upload?.videoUrl || "",
    public_thumbnail_url: result.upload?.thumbnailUrl || "",
    youtube_status: platformResults ? platformPublishStatus(platformResults, "youtube", config.youtube.enabled) : "",
    youtube_video_id: result.platformResults?.youtube?.videoId || "",
    youtube_url: result.platformResults?.youtube?.url || "",
    instagram_status: platformResults ? platformPublishStatus(platformResults, "instagram", config.instagram.enabled) : "",
    instagram_media_id: result.platformResults?.instagram?.mediaId || "",
    facebook_status: platformResults ? platformPublishStatus(platformResults, "facebook", config.facebook.enabled) : "",
    facebook_video_id: result.platformResults?.facebook?.videoId || "",
    tiktok_status: platformResults ? platformPublishStatus(platformResults, "tiktok", config.tiktok.enabled, "submitted") : "",
    tiktok_publish_id: result.platformResults?.tiktok?.publishId || "",
    threads_status: platformResults ? platformPublishStatus(platformResults, "threads", config.threads.enabled) : "",
    threads_media_id: result.platformResults?.threads?.mediaId || "",
    final_video_path: result.output?.finalAbsPath || "",
    original_final_video_path: result.output?.originalFinalAbsPath || "",
    start_time: result.output?.start ?? "",
    end_time: result.output?.end ?? "",
    duration: result.output?.duration ?? "",
    candidate_id: result.output?.candidateId || "",
    viral_score: result.output?.viralScore || 0,
    video_effects: result.output?.videoEffects || null,
    background_music: result.output?.backgroundMusic || null,
    thumbnail_intro: result.output?.thumbnailIntro || { applied: false },
    frame_quote_text: result.output?.frameQuoteText || "",
    caption: result.caption || "",
    youtube_error: errors.youtube || "",
    instagram_error: errors.instagram || "",
    facebook_error: errors.facebook || "",
    tiktok_error: errors.tiktok || "",
    threads_error: errors.threads || ""
  };
}

function shouldUseLowerThird(video = {}, options = {}) {
  if (!config.videoEffects.lowerThirdEnabled) return false;
  const configured = options.useLowerThird ?? video.use_lower_third ?? config.videoEffects.lowerThirdEnabled;
  if (configured === undefined || configured === null || configured === "") return false;
  if (typeof configured === "boolean") return configured;
  return ["1", "true", "yes", "on"].includes(String(configured).toLowerCase());
}

export function finalStatusFromClipResults(clipResults, publishEnabled) {
  const successfulClips = clipResults.filter((item) => item.ok).length;
  const failedClips = clipResults.filter((item) => !item.ok).length;
  const publishedClips = clipResults.filter((item) => item.primaryPublished).length;
  const hasPlatformErrors = clipResults.some((item) => item.platformResults?.hasErrors);
  const hasYoutubeQuotaExceeded = clipResults.some((item) => item.platformResults?.quotaExceeded?.youtube);
  const hasYoutubeDailyLimitReached = clipResults.some((item) => item.platformResults?.dailyLimitReached?.youtube);
  const total = clipResults.length;

  if (!publishEnabled) {
    return {
      status: failedClips ? "partial_ready" : "ready_to_publish",
      publishStatus: failedClips ? "partial_ready" : "ready_to_publish",
      videoStatus: failedClips ? "partial_ready" : "ready_to_publish",
      event: failedClips ? "partial_ready" : "ready_to_publish",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: failedClips ? `${failedClips}/${total} clip gagal diproses.` : ""
    };
  }

  if (publishedClips === total) {
    return {
      status: "published",
      publishStatus: hasPlatformErrors ? "published_with_warnings" : "published",
      videoStatus: "published",
      event: hasPlatformErrors ? "published_with_warnings" : "published",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: hasPlatformErrors ? "Semua clip berhasil publish, tapi ada platform yang gagal atau tertunda." : ""
    };
  }

  if (publishedClips > 0) {
    return {
      status: "published_partial",
      publishStatus: hasPlatformErrors || failedClips ? "published_with_warnings" : "published_partial",
      videoStatus: "published_partial",
      event: "published_partial",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: `${publishedClips}/${total} clip berhasil publish.`
    };
  }

  if (hasYoutubeQuotaExceeded || hasYoutubeDailyLimitReached) {
    return {
      status: "queued",
      publishStatus: "queued",
      videoStatus: "queued",
      event: hasYoutubeDailyLimitReached ? "youtube_daily_limit_deferred" : "youtube_quota_deferred",
      successfulClips,
      failedClips,
      publishedClips,
      errorMessage: hasYoutubeDailyLimitReached
        ? "Batas upload YouTube harian tercapai; video dikembalikan ke queue untuk jadwal berikutnya."
        : "Quota YouTube habis; video dikembalikan ke queue untuk jadwal berikutnya."
    };
  }

  return {
    status: "ready_to_publish",
    publishStatus: "publish_failed",
    videoStatus: "ready_to_publish",
    event: "publish_failed",
    successfulClips,
    failedClips,
    publishedClips,
    errorMessage: "Publish platform gagal; siap retry."
  };
}

async function updateJob(jobId, patch) {
  return patchItem("jobs", jobId, patch);
}

function publishDecisionFromConfig() {
  return selectPublishPlatforms(enabledPublishPlatformsFromConfig(config), config.safePublishMode);
}

function workflowPublishEnabled(options) {
  if (!(options.publish && canPublish())) return false;
  const decision = publishDecisionFromConfig();
  if (decision.mode === "all") return true;
  return decision.hasSelectedPlatform;
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

async function publishPlatforms({
  job,
  output,
  caption,
  upload,
  thumbnail,
  publishDecision = publishDecisionFromConfig(),
  clipIndex = 1
}) {
  const socialCaption = stripCaptionSourceCredit(caption, {
    sourceUrl: job.source_url
  });
  const platformResults = {
    instagram: null,
    facebook: null,
    tiktok: null,
    youtube: null,
    threads: null,
    errors: {},
    quotaExceeded: {},
    dailyLimitReached: {},
    hasAnySuccess: false,
    hasErrors: false
  };

  platformResults.safePublishMode = publishDecision.mode;
  platformResults.skippedBySafeMode = publishDecision.skippedBySafeMode;

  await appendSafePublishModeSkips(job.job_id, publishDecision);

  if (publishDecision.platforms.youtube) {
    const cooldown = await youtubeQuotaCooldown("upload");
    if (cooldown.active) {
      platformResults.hasErrors = true;
      platformResults.quotaExceeded.youtube = true;
      platformResults.errors.youtube = `YouTube quota cooldown aktif sampai ${cooldown.until}.`;
      await updateJob(job.job_id, {
        youtube_status: "quota_exceeded",
        youtube_error: platformResults.errors.youtube
      });
      await appendLog("youtube_quota_cooldown_skip", {
        job_id: job.job_id,
        until: cooldown.until,
        reason: cooldown.reason || ""
      });
      console.warn(`YouTube upload dilewati sampai reset quota: ${cooldown.until}`);
    } else {
      const dailyLimit = youtubeDailyUploadLimit();
      const postedToday = dailyLimit > 0 ? await youtubePublishedCountToday() : 0;
      if (dailyLimit > 0 && postedToday >= dailyLimit) {
        platformResults.hasErrors = true;
        platformResults.dailyLimitReached.youtube = true;
        platformResults.errors.youtube = `Batas upload YouTube harian tercapai (${postedToday}/${dailyLimit}).`;
        await updateJob(job.job_id, {
          youtube_status: "daily_limit_reached",
          youtube_error: platformResults.errors.youtube
        });
        await appendLog("youtube_daily_limit_skip", {
          job_id: job.job_id,
          posted_today: postedToday,
          daily_limit: dailyLimit
        });
        console.warn(`YouTube upload dilewati: batas harian ${postedToday}/${dailyLimit}.`);
      } else {
        platformResults.youtube = await publishPlatform("youtube", platformResults, job.job_id, async () => {
          await updateJob(job.job_id, { youtube_status: "processing", youtube_error: "" });
          const youtubeMetadata = buildYoutubeMetadata({ job, output, caption: socialCaption });
          return publishToYoutube({
            videoPath: output.finalAbsPath,
            thumbnailPath: thumbnail?.path || "",
            ...youtubeMetadata
          });
        });
        if (platformResults.quotaExceeded.youtube) {
          const quotaState = await markYoutubeQuotaExceeded("upload", platformResults.errors.youtube);
          if (quotaState.until) {
            console.warn(`YouTube quota cooldown disimpan sampai ${quotaState.until}.`);
          }
        } else if (platformResults.youtube) {
          await clearYoutubeQuotaExceeded("upload");
        }
      }
    }

    if (platformResults.quotaExceeded.youtube) {
      await appendLog("youtube_quota_continue_social_publish", {
        job_id: job.job_id,
        error: platformResults.errors.youtube || ""
      });
      console.warn("Quota YouTube habis; platform sosmed lain tetap dicoba.");
    }
  }

  if (publishDecision.platforms.tiktok) {
    platformResults.tiktok = await publishPlatform("tiktok", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish TikTok.");
      await updateJob(job.job_id, { tiktok_status: "processing", tiktok_error: "" });
      return publishToTikTok({
        videoUrl: upload.videoUrl,
        videoPath: output.finalAbsPath,
        caption: socialCaption
      });
    });
  }

  const metaDelayMs = metaInterClipDelayMs({
    clipIndex,
    platforms: publishDecision.platforms
  });
  if (metaDelayMs > 0) {
    await appendLog("meta_inter_clip_delay", {
      job_id: job.job_id,
      clip_index: clipIndex,
      delay_seconds: metaDelayMs / 1000,
      platforms: ["facebook", "instagram", "threads"]
        .filter((name) => publishDecision.platforms[name])
    });
    console.log(
      `Jeda Meta ${metaDelayMs / 1000} detik sebelum FB/IG/Threads clip ${clipIndex}.`
    );
    await waitForMetaInterClipDelay({
      clipIndex,
      platforms: publishDecision.platforms
    });
  }

  if (publishDecision.platforms.facebook) {
    platformResults.facebook = await publishPlatform("facebook", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish Facebook.");
      await updateJob(job.job_id, { facebook_status: "processing", facebook_error: "" });
      const facebookCover = await prepareFacebookCover({
        job,
        sourcePath: output.finalAbsPath
      });
      await updateJob(job.job_id, {
        facebook_cover_path: facebookCover.coverPath || "",
        facebook_cover_url: facebookCover.coverUrl || ""
      });
      return publishToFacebook({
        videoUrl: upload.videoUrl,
        videoPath: output.finalAbsPath,
        title: output.title || job.source_title || "Podcast Clip",
        description: socialCaption,
        thumbnailPath: facebookCover.coverPath || thumbnail?.path || ""
      });
    });
  }

  if (publishDecision.platforms.instagram) {
    platformResults.instagram = await publishPlatform("instagram", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish Instagram.");
      await updateJob(job.job_id, { instagram_status: "processing", instagram_error: "" });
      const instagramVideo = await prepareInstagramVideo({
        job,
        sourcePath: output.finalAbsPath,
        currentVideoUrl: upload.videoUrl
      });
      const instagramCover = await prepareInstagramCover({
        job,
        sourcePath: instagramVideo.videoPath
      });
      const instagramCoverUrl = instagramCover.coverUrl || upload.thumbnailUrl || "";
      if (instagramCoverUrl) {
        await validatePublicUrl(instagramCoverUrl);
      }
      await updateJob(job.job_id, {
        instagram_cover_path: instagramCover.coverPath || "",
        instagram_cover_url: instagramCover.coverUrl || ""
      });
      return publishReel({
        videoUrl: instagramVideo.videoUrl,
        caption: socialCaption,
        coverUrl: instagramCoverUrl
      });
    });
  }

  if (publishDecision.platforms.threads) {
    platformResults.threads = await publishPlatform("threads", platformResults, job.job_id, async () => {
      if (!upload.videoUrl) throw new Error("PUBLIC_BASE_URL/SFTP wajib valid sebelum publish Threads.");
      await updateJob(job.job_id, { threads_status: "processing", threads_error: "" });
      return publishToThreads({
        videoUrl: upload.videoUrl,
        caption: socialCaption
      });
    });
  }

  return platformResults;
}

function platformPublishStatus(platformResults, name, enabled, successStatus = "published") {
  if (platformResults?.[name]) {
    // TikTok direct post langsung publik -> "published". Inbox/draft -> "submitted".
    if (name === "tiktok") {
      return platformResults.tiktok?.mode === "direct" ? "published" : "submitted";
    }
    return successStatus;
  }
  if (!enabled) return "disabled";
  if (name === "youtube" && platformResults?.dailyLimitReached?.youtube) return "daily_limit_reached";
  if (name === "youtube" && platformResults?.quotaExceeded?.youtube) return "quota_exceeded";
  if (platformResults?.errors?.[name]) return "failed";
  return "skipped";
}

async function publishPlatform(name, platformResults, jobId, callback) {
  try {
    const result = await callback();
    if (result) platformResults.hasAnySuccess = true;
    return result;
  } catch (error) {
    platformResults.hasErrors = true;
    platformResults.errors[name] = error.message;
    if (name === "youtube" && isYoutubeQuotaError(error)) {
      platformResults.quotaExceeded.youtube = true;
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

function buildMetadata({ job, video, theme, prompt, output, clipperResult, caption, thumbnail, clipIndex = 1, clipTotal = 1, videoEffects = null }) {
  return {
    job_id: job.job_id,
    clip_index: clipIndex,
    clip_total: clipTotal,
    source_type: "youtube_video",
    source_url: video.url,
    youtube_video_id: video.youtube_video_id,
    source_title: output.title || "",
    theme: theme?.name || job.theme,
    prompt_id: prompt?.id || "",
    status: "done",
    transcriptSource: output.transcriptSource || "",
    finalPath: output.finalAbsPath,
    originalFinalPath: output.originalFinalAbsPath || "",
    videoEffects,
    backgroundMusic: output.backgroundMusic || {},
    thumbnailIntro: output.thumbnailIntro || { applied: false },
    frameQuoteText: output.frameQuoteText || "",
    transcriptPath: output.transcriptReviewAbsPath || "",
    subtitlePath: output.subtitleAbsPath || "",
    thumbnailPath: thumbnail.path,
    thumbnailText: thumbnail.text,
    caption,
    startTime: output.start,
    endTime: output.end,
    duration: output.duration,
    clipTranscript: output.clipTranscript || "",
    viralScore: output.viralScore || 0,
    selectedAngle: output.selectedAngle || "",
    publishDecision: output.publishDecision || "",
    candidateId: output.candidateId || "",
    hashtags: output.hashtags || [],
    clipperJobId: clipperResult.jobId,
    createdAt: new Date().toISOString()
  };
}

function youtubeDailyUploadLimit() {
  const value = Number(process.env.YOUTUBE_DAILY_UPLOAD_LIMIT);
  if (!Number.isFinite(value)) return config.youtube.dailyUploadLimit || 0;
  return Math.max(0, Math.floor(value));
}

async function queueSeriesStatusPatch({ job, video, options, final, clipResults = [] }) {
  if (!(options.scheduled && isAutomationSeriesVideo(video))) {
    return { patch: {}, videoStatus: "", errorMessage: undefined };
  }

  const currentCount = await queueSeriesSuccessCount(video);
  const targetCount = queueSeriesTarget(video);
  const nextCount = Math.min(targetCount, currentCount + Math.max(0, final.publishedClips || 0));
  const completed = nextCount >= targetCount;
  const now = new Date().toISOString();

  // Catat range clip yang baru berhasil publish ke ledger video (videos.json)
  // agar run berikutnya menghindari segmen yang sama. Ini sumber otoritatif,
  // tahan terhadap trimming/lost-update history.json global.
  const newRanges = clipResults
    .filter((item) => item?.ok && item?.primaryPublished)
    .map((item) => ({ start: item?.output?.start, end: item?.output?.end }));
  const mergedRanges = dedupeClipRanges([
    ...storedSeriesClipRanges(video),
    ...newRanges
  ]).slice(-40);

  const patch = {
    automation_series: true,
    queue_series: true,
    series_target_count: targetCount,
    series_success_count: nextCount,
    series_remaining_count: Math.max(0, targetCount - nextCount),
    series_clip_ranges: mergedRanges,
    last_series_job_id: job.job_id,
    last_series_run_at: now
  };

  if (completed) {
    patch.series_completed_at = video.series_completed_at || now;
    return { patch, videoStatus: "published", errorMessage: final.errorMessage };
  }

  if (final.publishedClips > 0) {
    return { patch, videoStatus: "queued", errorMessage: "" };
  }

  return { patch, videoStatus: final.videoStatus, errorMessage: final.errorMessage };
}

async function appendHistoryEntry({ job, video, caption, output, upload, platformResults = {}, status, clipIndex = 1, clipTotal = 1, options = {} }) {
  const queueSeries = Boolean(options.scheduled && isAutomationSeriesVideo(video));
  await appendHistory({
    job_id: job.job_id,
    clip_index: clipIndex,
    clip_total: clipTotal,
    video_id: video.id,
    queue_series: queueSeries,
    automation_series: isAutomationSeriesVideo(video),
    scheduled_run: options.scheduled === true,
    manual_run: options.scheduled !== true,
    series_target_count: queueSeries ? queueSeriesTarget(video) : 0,
    source_youtube_video_id: video.youtube_video_id,
    source_url: video.url,
    theme: job.theme,
    status,
    publish_date: status === "published" ? todayDate() : "",
    final_video_path: output.finalAbsPath,
    original_final_video_path: output.originalFinalAbsPath || "",
    video_effects: output.videoEffects || "",
    background_music: output.backgroundMusic || "",
    thumbnail_intro: output.thumbnailIntro || { applied: false },
    public_video_url: upload.videoUrl || "",
    public_thumbnail_url: upload.thumbnailUrl || "",
    caption,
    start_time: output.start,
    end_time: output.end,
    duration: output.duration,
    candidate_id: output.candidateId || "",
    viral_score: output.viralScore || 0,
    selected_angle: output.selectedAngle || "",
    instagram_media_id: platformResults.instagram?.mediaId || "",
    facebook_video_id: platformResults.facebook?.videoId || "",
    facebook_post_id: platformResults.facebook?.postId || "",
    facebook_url: platformResults.facebook?.url || "",
    youtube_video_id: platformResults.youtube?.videoId || "",
    youtube_url: platformResults.youtube?.url || "",
    tiktok_publish_id: platformResults.tiktok?.publishId || "",
    tiktok_mode: platformResults.tiktok?.mode || "",
    threads_media_id: platformResults.threads?.mediaId || "",
    threads_url: platformResults.threads?.url || "",
    published_at: status === "published" ? new Date().toISOString() : ""
  });
}

async function uploadHistoryIfPossible() {
  const historyFile = path.join(config.dataDir, "history.json");
  try {
    await fs.access(historyFile);
    await uploadHistoryFile(historyFile);
  } catch {
    // History upload is best effort.
  }
}
