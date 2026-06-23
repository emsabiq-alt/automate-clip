const STATE_URL = "/api/state";
const POLL_ACTIVE_MS = 3000;
const POLL_IDLE_MS = 30000;
const ROW_LIMIT_DEFAULT = 5;
const ROW_LIMIT_EXPANDED = 32;

const PIPELINE_STEPS = [
  "Queue",
  "Clipper",
  "Branding",
  "Caption",
  "TTS Intro",
  "Storage",
  "Instagram",
  "Facebook",
  "YouTube",
  "TikTok",
  "Threads",
  "History"
];

let dashboardPin =
  new URLSearchParams(window.location.search).get("pin") ||
  window.sessionStorage.getItem("dashboardPin") ||
  "";
let authVisible = true;
let pollTimer = null;
let lastRunStatus = "idle";
let latestActiveRun = null;
let focusMode = window.sessionStorage.getItem("dashboardFocusMode") === "1";
let cachedVideos = [];
let cachedJobs = [];
let latestVideoJob = null;
let ttsAudioUrl = "";
let introPreviewAudioUrl = "";
let introPreviewAudio = null;
let ttsAudioContext = null;
const ttsGainNodes = new WeakMap();
let videoLimit = ROW_LIMIT_DEFAULT;
let jobLimit = ROW_LIMIT_DEFAULT;
let effectDefaults = {
  use_frame: true,
  use_filter: true,
  use_watermark: false,
  use_music: true,
  use_subtitle_highlight: false
};
let effectDefaultsApplied = false;

if (dashboardPin) {
  window.sessionStorage.setItem("dashboardPin", dashboardPin);
  const cleanUrl = new URL(window.location.href);
  if (cleanUrl.searchParams.has("pin")) {
    cleanUrl.searchParams.delete("pin");
    window.history.replaceState({}, "", cleanUrl);
  }
}

const els = {
  authOverlay: document.querySelector("#authOverlay"),
  authForm: document.querySelector("#authForm"),
  authPin: document.querySelector("#authPin"),
  authError: document.querySelector("#authError"),
  configLine: document.querySelector("#configLine"),
  liveClock: document.querySelector("#liveClock"),
  refreshBtn: document.querySelector("#refreshBtn"),
  preflightBtn: document.querySelector("#preflightBtn"),
  focusModeBtn: document.querySelector("#focusModeBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  metrics: document.querySelector("#metrics"),
  workflowTitle: document.querySelector("#workflowTitle"),
  workflowMeta: document.querySelector("#workflowMeta"),
  workflowGraph: document.querySelector("#workflowGraph"),
  runBadge: document.querySelector("#runBadge"),
  runTimer: document.querySelector("#runTimer"),
  runLink: document.querySelector("#runLink"),
  runStatus: document.querySelector("#runStatus"),
  runDetail: document.querySelector("#runDetail"),
  runProgressLabel: document.querySelector("#runProgressLabel"),
  progressBar: document.querySelector("#progressBar"),
  queueGaugeLabel: document.querySelector("#queueGaugeLabel"),
  queueGaugeFill: document.querySelector("#queueGaugeFill"),
  insightList: document.querySelector("#insightList"),
  trendChart: document.querySelector("#trendChart"),
  trendCaption: document.querySelector("#trendCaption"),
  dailyBars: document.querySelector("#dailyBars"),
  barCaption: document.querySelector("#barCaption"),
  platformGrid: document.querySelector("#platformGrid"),
  platformCaption: document.querySelector("#platformCaption"),
  youtubeReconnectBtn: document.querySelector("#youtubeReconnectBtn"),
  latestVideoBadge: document.querySelector("#latestVideoBadge"),
  latestVideoPreview: document.querySelector("#latestVideoPreview"),
  ttsBadge: document.querySelector("#ttsBadge"),
  ttsText: document.querySelector("#ttsText"),
  ttsTestBtn: document.querySelector("#ttsTestBtn"),
  ttsAudio: document.querySelector("#ttsAudio"),
  ttsStatus: document.querySelector("#ttsStatus"),
  runForm: document.querySelector("#runForm"),
  videoForm: document.querySelector("#videoForm"),
  consoleOutput: document.querySelector("#consoleOutput"),
  consoleMeta: document.querySelector("#consoleMeta"),
  copyConsoleBtn: document.querySelector("#copyConsoleBtn"),
  safeModeBadge: document.querySelector("#safeModeBadge"),
  storageMode: document.querySelector("#storageMode"),
  storageHint: document.querySelector("#storageHint"),
  diagnosticCount: document.querySelector("#diagnosticCount"),
  lastDiagnostic: document.querySelector("#lastDiagnostic"),
  diagnosticFeed: document.querySelector("#diagnosticFeed"),
  readyJobCount: document.querySelector("#readyJobCount"),
  readyJobHint: document.querySelector("#readyJobHint"),
  queueHeat: document.querySelector("#queueHeat"),
  queueHeatHint: document.querySelector("#queueHeatHint"),
  videoRows: document.querySelector("#videoRows"),
  videoCount: document.querySelector("#videoCount"),
  videoSearch: document.querySelector("#videoSearch"),
  videoFilter: document.querySelector("#videoFilter"),
  videosMore: document.querySelector("#videosMore"),
  resetQueueBtn: document.querySelector("#resetQueueBtn"),
  jobRows: document.querySelector("#jobRows"),
  jobCount: document.querySelector("#jobCount"),
  jobSearch: document.querySelector("#jobSearch"),
  jobFilter: document.querySelector("#jobFilter"),
  jobsMore: document.querySelector("#jobsMore")
};

class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

async function api(path, options = {}) {
  const headers = { Accept: "application/json" };
  if (options.body) headers["Content-Type"] = "application/json";
  if (dashboardPin) headers["X-Dashboard-Pin"] = dashboardPin;

  const response = await fetch(path, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new ApiError(
      `Server tidak mengembalikan JSON (${response.status}). ${short(text.replace(/\s+/g, " "), 120)}`,
      response.status
    );
  }

  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || "Request gagal.", response.status);
  return data;
}

async function refresh() {
  const state = await api(STATE_URL);
  hideAuth();

  const stats = buildStats(state);
  renderConfigLine(state.config || {});
  applyEffectDefaults(state.config || {});
  renderMetrics(stats);
  renderReliability(state, stats);
  renderRun(state, stats);
  renderInsights(stats);
  renderCharts(stats);
  renderPlatforms(state.config || {}, stats);
  renderLatestVideoPreview(state.jobs || []);
  renderTtsConfig(state.config || {});
  renderConsole(state.activeRun);
  renderVideos(state.videos || []);
  renderJobs(state.jobs || []);

  lastRunStatus = state.activeRun?.status === "running" ? "running" : "idle";
}

function buildStats(state) {
  const cfg = state.config || {};
  const videos = state.videos || [];
  const jobs = state.jobs || [];
  const history = state.history || [];
  const today = todayIsoDate();
  const youtubeDailyLimit = Number(cfg.youtubeDailyUploadLimit || 6) || 6;
  const dailyLimit = Number(cfg.autoDiscoverDailyQueueLimit || cfg.maxScheduledPostsPerDay || youtubeDailyLimit || 15) || 15;
  const activeVideos = videos.filter((video) => video.status !== "expired");
  const activeQueue = activeVideos.filter((video) => (video.status || "queued") === "queued").length;
  const staleQueue = activeVideos.filter(isStaleAutoQueue).length;
  const expiredQueue = videos.filter((video) => video.status === "expired").length;
  const publishedJobs = jobs.filter(isPublishedJob).length;
  const failedJobs = jobs.filter((job) => String(job.status || "").includes("failed")).length;
  const warningJobs = jobs.filter((job) => job.publish_status === "published_with_warnings").length;
  const readyJobs = jobs.filter((job) => ["ready_to_publish", "queued"].includes(job.status) || ["ready_to_publish", "queued"].includes(job.publish_status)).length;
  const todayPublished = publishedCountForDate(today, history, jobs);
  const youtubeToday = youtubePublishedCountForDate(today, history, jobs);
  const series = lastDays(7).map((date) => ({
    date,
    published: publishedCountForDate(date, history, jobs),
    failed: failedCountForDate(date, jobs)
  }));
  const previousSeries = previousDays(7, 7).map((date) => publishedCountForDate(date, history, jobs));
  const total7 = series.reduce((sum, day) => sum + day.published, 0);
  const prev7 = previousSeries.reduce((sum, value) => sum + value, 0);
  const processed = publishedJobs + failedJobs + warningJobs;
  const successRate = processed ? Math.round((publishedJobs / processed) * 100) : 0;
  const trendDelta = total7 - prev7;

  return {
    cfg,
    today,
    dailyLimit,
    youtubeDailyLimit,
    videos,
    activeVideos,
    activeQueue,
    staleQueue,
    expiredQueue,
    jobs,
    history,
    publishedJobs,
    failedJobs,
    warningJobs,
    readyJobs,
    todayPublished,
    youtubeToday,
    series,
    total7,
    prev7,
    trendDelta,
    successRate,
    queueLoadPct: Math.min(100, Math.round((activeQueue / Math.max(1, dailyLimit)) * 100)),
    youtubeLoadPct: Math.min(100, Math.round((youtubeToday / Math.max(1, youtubeDailyLimit)) * 100))
  };
}

function renderConfigLine(cfg) {
  const parts = [
    cfg.dryRun ? "dry-run" : "live",
    cfg.autoPublish ? "publish on" : "publish off",
    `safe ${cfg.safePublishMode || "all"}`,
    `storage ${(cfg.uploadDriver || "local").toUpperCase()}`,
    `AI ${(cfg.aiProvider || "openai").toUpperCase()}`,
    `transkrip ${(cfg.transcribeProvider || "deepgram").toUpperCase()}`,
    `FX ${effectSummary(cfg)}`,
    cfg.timezone || ""
  ].filter(Boolean);
  els.configLine.textContent = parts.join(" / ");
}

function renderMetrics(stats) {
  const loadTone = stats.activeQueue > stats.dailyLimit ? "warn" : "info";
  const youtubeTone = stats.youtubeToday >= stats.youtubeDailyLimit ? "warn" : "ok";
  const staleTone = stats.staleQueue ? "bad" : "ok";
  const trend = stats.trendDelta > 0 ? `+${stats.trendDelta} vs prev` : `${stats.trendDelta} vs prev`;
  els.metrics.innerHTML = [
    metricCard("YouTube hari ini", `${stats.youtubeToday}/${stats.youtubeDailyLimit}`, youtubeTone, `${stats.youtubeLoadPct}% limit`),
    metricCard("Queue aktif", stats.activeQueue, loadTone, `${stats.queueLoadPct}% dari slot`),
    metricCard("Publish total", stats.todayPublished, "ok", "semua platform"),
    metricCard("Trend 7D", stats.total7, "info", trend),
    metricCard("Success rate", `${stats.successRate}%`, stats.successRate >= 80 ? "ok" : "warn", `${stats.failedJobs} failed`),
    metricCard("Queue lama", stats.staleQueue, staleTone, `${stats.expiredQueue} expired`)
  ].join("");
}

function renderReliability(state, stats) {
  const cfg = state.config || {};
  const diagnostics = state.diagnostics || [];
  const latestDiagnostic = diagnostics[0] || null;
  const safeMode = cfg.safePublishMode || "all";
  const storage = String(cfg.uploadDriver || "local").toUpperCase();
  const readyHint = stats.readyJobs ? `${stats.readyJobs} job bisa dipantau` : "Tidak ada backlog ready";
  const storageHint = cfg.remoteUploadRequired
    ? "Remote wajib, timeout perlu diperhatikan"
    : storage === "LOCAL" ? "Mode file lokal" : "Remote optional fallback";

  if (els.safeModeBadge) {
    els.safeModeBadge.textContent = safeMode;
    els.safeModeBadge.classList.toggle("warn", safeMode !== "all");
  }
  if (els.storageMode) els.storageMode.textContent = storage;
  if (els.storageHint) els.storageHint.textContent = storageHint;
  if (els.diagnosticCount) els.diagnosticCount.textContent = diagnostics.length;
  if (els.lastDiagnostic) {
    els.lastDiagnostic.textContent = latestDiagnostic
      ? `${latestDiagnostic.stage || "issue"} / ${short(latestDiagnostic.error_message || latestDiagnostic.job_id || latestDiagnostic.name, 44)}`
      : "Tidak ada issue baru";
  }
  if (els.diagnosticFeed) {
    els.diagnosticFeed.innerHTML = diagnostics.length
      ? diagnostics.slice(0, 3).map((item) => `
          <article>
            <strong>${escapeHtml(item.stage || item.status || "diagnostic")}</strong>
            <span>${escapeHtml(short(item.error_message || item.job_id || item.name || "Issue tercatat", 72))}</span>
            <small>${escapeHtml(formatDateTime(item.timestamp || item.updated_at))}</small>
          </article>
        `).join("")
      : "<span>Tidak ada diagnostic terbaru.</span>";
  }
  if (els.readyJobCount) els.readyJobCount.textContent = stats.readyJobs;
  if (els.readyJobHint) els.readyJobHint.textContent = readyHint;
  if (els.queueHeat) els.queueHeat.textContent = `${stats.queueLoadPct}%`;
  if (els.queueHeatHint) {
    els.queueHeatHint.textContent = stats.activeQueue > stats.dailyLimit
      ? "Backlog melewati slot"
      : `${stats.activeQueue}/${stats.dailyLimit} slot terpakai`;
  }
}

function metricCard(label, value, tone, detail) {
  return `
    <article class="metric ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <small>${escapeHtml(detail)}</small>
    </article>
  `;
}

function renderRun(state, stats) {
  const run = state.activeRun;
  latestActiveRun = run || null;
  setSubmittersDisabled(run?.status === "running");

  if (!run) {
    els.runBadge.textContent = "Idle";
    els.runBadge.className = "runBadge idle";
    els.workflowTitle.textContent = "Menunggu proses";
    els.workflowMeta.textContent = `Queue aktif ${stats.activeQueue}, YouTube ${stats.youtubeToday}/${stats.youtubeDailyLimit} hari ini`;
    els.runStatus.textContent = "Idle";
    els.runDetail.textContent = "Siap menerima link YouTube atau menjalankan queue.";
    els.runProgressLabel.textContent = "0%";
    if (els.runTimer) els.runTimer.textContent = "00:00";
    els.progressBar.style.width = "0%";
    els.progressBar.classList.remove("running");
    els.runLink.hidden = true;
    renderWorkflow(buildPipelineSteps(state));
    return;
  }

  const status = run.status || "running";
  const pct = typeof run.progress === "number" ? run.progress : status === "running" ? 12 : 100;
  els.runBadge.textContent = status === "running" ? "Running" : status;
  els.runBadge.className = `runBadge ${status}`;
  els.workflowTitle.textContent = run.title || run.name || "Workflow";
  els.workflowMeta.textContent = run.branch
    ? `${run.name || "Workflow"} / ${run.branch} / ${formatTime(run.startedAt)}`
    : `${run.name || "Workflow"} / ${formatTime(run.startedAt)}`;
  els.runStatus.textContent = status;
  els.runDetail.textContent = run.detail || run.error || "Workflow berjalan";
  els.runProgressLabel.textContent = `${pct}%`;
  els.progressBar.style.width = `${pct}%`;
  els.progressBar.classList.toggle("running", status === "running");
  els.runLink.href = run.htmlUrl || "#";
  els.runLink.hidden = !run.htmlUrl;
  updateRunTimer();
  renderWorkflow(run.jobs?.length ? buildLiveSteps(run.jobs) : buildPipelineSteps(state));
}

function renderWorkflow(steps) {
  els.workflowGraph.innerHTML = steps.map((step, index) => `
    <article class="processNode ${escapeAttr(step.state || "pending")}">
      <i>${index + 1}</i>
      <strong>${escapeHtml(step.label)}</strong>
      <small>${escapeHtml(step.detail || "")}</small>
    </article>
  `).join("");
}

function buildLiveSteps(jobs) {
  const steps = [];
  jobs.forEach((job) => {
    (job.steps || []).forEach((step) => {
      steps.push({
        label: step.name || "Step",
        detail: liveStepDetail(step),
        state: mapStepState(step)
      });
    });
  });
  return steps.length ? steps : PIPELINE_STEPS.map((label) => ({ label, detail: "Menunggu", state: "pending" }));
}

function liveStepDetail(step) {
  if (step.status === "completed" && step.started_at && step.completed_at) {
    return `${step.conclusion || "done"} / ${durationSeconds(step.started_at, step.completed_at)}s`;
  }
  if (step.status === "in_progress") return "Sedang berjalan";
  if (step.status === "queued") return "Menunggu runner";
  return step.conclusion || step.status || "Menunggu";
}

function buildPipelineSteps(state) {
  const job = currentJob(state);
  if (!job) {
    return PIPELINE_STEPS.map((label) => ({ label, detail: "Menunggu", state: "pending" }));
  }

  const failed = isFailed(job.status) || Boolean(job.error_message);
  const clipperDone = job.clipper_status === "done" || Boolean(job.final_video_path);
  const captionDone = job.caption_status === "done" || Boolean(job.caption);
  const thumbnailDone = job.thumbnail_status === "done" || Boolean(job.thumbnail_path);
  const thumbnailDetail = job.thumbnail_intro?.ttsApplied
    ? `TTS ${Number(job.thumbnail_intro.durationSeconds || 0).toFixed(1)}s`
    : job.thumbnail_status || "TTS Intro";
  const storageDone = Boolean(job.public_video_url);
  const published = isPublishedJob(job);

  return [
    { label: "Queue", state: "done", detail: job.video_id || "Selected" },
    { label: "Clipper", state: stepState(failed && !clipperDone, isActive(job, ["clipper_processing"]), clipperDone), detail: job.clipper_status || "Render" },
    { label: "Branding", state: stepState(false, clipperDone && !job.video_effects && !failed, Boolean(job.video_effects)), detail: job.video_effects ? "FX applied" : "Frame/filter" },
    { label: "Caption", state: stepState(failed && clipperDone && !captionDone, clipperDone && !captionDone && !failed, captionDone), detail: job.caption_status || "Caption" },
    { label: "TTS Intro", state: stepState(failed && captionDone && !thumbnailDone, captionDone && !thumbnailDone && !failed, thumbnailDone), detail: thumbnailDetail },
    { label: "Storage", state: stepState(failed && thumbnailDone && !storageDone, thumbnailDone && !storageDone && !failed, storageDone), detail: storageDone ? "Public URL" : "Upload" },
    platformStep("Instagram", job.instagram_status, Boolean(job.instagram_media_id), storageDone, failed),
    platformStep("Facebook", job.facebook_status, Boolean(job.facebook_video_id || job.facebook_post_id), storageDone, failed),
    platformStep("YouTube", job.youtube_status, Boolean(job.youtube_url), storageDone, failed),
    platformStep("TikTok", job.tiktok_status, Boolean(job.tiktok_publish_id), storageDone, failed),
    platformStep("Threads", job.threads_status, Boolean(job.threads_media_id), storageDone, failed),
    { label: "History", state: stepState(failed, !published && ["publishing", "ready_to_publish"].includes(job.status), published), detail: published ? "Published" : job.publish_status || job.status || "Menunggu" }
  ];
}

function platformStep(label, status, hasResult, storageDone, failed) {
  const normalized = String(status || "").toLowerCase();
  const disabled = normalized === "disabled";
  return {
    label,
    state: stepState(isFailed(status) || (failed && storageDone && !hasResult && !disabled), storageDone && normalized === "processing" && !failed, hasResult || normalized === "published" || normalized === "submitted", disabled || normalized === "skipped"),
    detail: disabled ? "Off" : hasResult ? "Done" : status || "Menunggu"
  };
}

function renderInsights(stats) {
  const queueTone = stats.activeQueue > stats.dailyLimit ? "warn" : "ok";
  const youtubeTone = stats.youtubeToday >= stats.youtubeDailyLimit ? "warn" : "ok";
  const items = [
    {
      tone: youtubeTone,
      title: stats.youtubeToday >= stats.youtubeDailyLimit ? "Limit YouTube tercapai" : "YouTube masih aman",
      body: `${stats.youtubeToday}/${stats.youtubeDailyLimit} upload YouTube hari ini.`
    },
    {
      tone: queueTone,
      title: stats.activeQueue > stats.dailyLimit ? "Backlog di atas slot" : "Queue sesuai slot",
      body: `${stats.activeQueue}/${stats.dailyLimit} queue aktif untuk ritme harian.`
    },
    {
      tone: stats.staleQueue ? "bad" : "ok",
      title: stats.staleQueue ? "Queue lama terlihat" : "Queue lama bersih",
      body: stats.staleQueue ? `${stats.staleQueue} item bisa direset menjadi expired.` : "Tampilan queue fokus ke item aktif."
    },
    {
      tone: stats.failedJobs ? "warn" : "ok",
      title: stats.failedJobs ? "Failure perlu pantau" : "Pipeline stabil",
      body: `${stats.failedJobs} failed, ${stats.warningJobs} warning, ${stats.readyJobs} ready.`
    },
    {
      tone: stats.trendDelta >= 0 ? "ok" : "warn",
      title: stats.trendDelta >= 0 ? "Trend naik atau stabil" : "Trend turun",
      body: `${stats.total7} publish dalam 7 hari terakhir.`
    }
  ];

  els.queueGaugeLabel.textContent = `${stats.activeQueue}/${stats.dailyLimit}`;
  els.queueGaugeFill.style.width = `${stats.queueLoadPct}%`;
  els.insightList.innerHTML = items.map((item) => `
    <article class="insight ${escapeAttr(item.tone)}">
      <b></b>
      <p><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span></p>
    </article>
  `).join("");
}

function renderCharts(stats) {
  renderTrendChart(stats.series);
  renderDailyBars(stats.series);
  els.trendCaption.textContent = `${stats.total7} total`;
  els.barCaption.textContent = stats.trendDelta >= 0 ? `+${stats.trendDelta}` : String(stats.trendDelta);
}

function renderTrendChart(series) {
  const width = 640;
  const height = 230;
  const pad = 30;
  const maxValue = Math.max(1, ...series.map((day) => day.published));
  const step = (width - pad * 2) / Math.max(1, series.length - 1);
  const points = series.map((day, index) => {
    const x = pad + index * step;
    const y = height - pad - (day.published / maxValue) * (height - pad * 2);
    return { x, y, ...day };
  });
  const line = points.map((point, index) => `${index ? "L" : "M"} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L ${points.at(-1)?.x || pad} ${height - pad} L ${pad} ${height - pad} Z`;
  const grid = [0, 0.5, 1].map((ratio) => {
    const y = pad + ratio * (height - pad * 2);
    return `<line class="chartGridLine" x1="${pad}" y1="${y}" x2="${width - pad}" y2="${y}"></line>`;
  }).join("");
  const dots = points.map((point) => `
    <circle class="chartDot" cx="${point.x}" cy="${point.y}" r="4"></circle>
    <text class="chartLabel" x="${point.x}" y="${height - 8}" text-anchor="middle">${labelDate(point.date)}</text>
  `).join("");

  els.trendChart.setAttribute("viewBox", `0 0 ${width} ${height}`);
  els.trendChart.innerHTML = `
    ${grid}
    <path class="chartArea" d="${area}"></path>
    <path class="chartPath" d="${line}"></path>
    ${dots}
  `;
}

function renderDailyBars(series) {
  const maxValue = Math.max(1, ...series.map((day) => day.published + day.failed));
  els.dailyBars.innerHTML = series.map((day) => {
    const total = day.published + day.failed;
    const height = Math.max(3, Math.round((total / maxValue) * 100));
    return `
      <article class="barItem">
        <div class="barTrack"><span class="barFill" style="height:${height}%"></span></div>
        <strong>${day.published}</strong>
        <small>${labelDate(day.date)}</small>
      </article>
    `;
  }).join("");
}

function renderPlatforms(cfg, stats) {
  const youtubeNeedsReconnect = youtubeReconnectIssue(stats.jobs);
  const items = [
    platformItem("Instagram", cfg.instagramEnabled, stats, "instagram"),
    platformItem("Facebook", cfg.facebookEnabled, stats, "facebook"),
    platformItem("YouTube", cfg.youtubeEnabled, stats, "youtube", youtubeNeedsReconnect ? "reconnect" : ""),
    platformItem(
      "TikTok",
      cfg.tiktokEnabled,
      stats,
      "tiktok",
      cfg.tiktokPaused ? "paused" : "",
      cfg.tiktokPublishMode || "direct"
    ),
    platformItem("Threads", cfg.threadsEnabled, stats, "threads"),
    ["Storage", Boolean(cfg.uploadDriver), (cfg.uploadDriver || "local").toUpperCase()],
    ["Publish", cfg.autoPublish && !cfg.dryRun, cfg.dryRun ? "dry-run" : cfg.autoPublish ? "auto" : "manual"],
    ["YT cap", stats.youtubeToday < stats.youtubeDailyLimit, `${stats.youtubeToday}/${stats.youtubeDailyLimit}`],
    ["Queue cap", stats.activeQueue <= stats.dailyLimit, `${stats.dailyLimit}/day`]
  ];
  els.platformGrid.innerHTML = items.map(([label, ok, value]) => `
    <article class="platformItem ${ok ? "ok" : "warn"}">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(value)}</span>
    </article>
  `).join("");
  els.platformCaption.textContent = stats.failedJobs ? `${stats.failedJobs} issue` : "Live";
}

function youtubeReconnectIssue(jobs = []) {
  const latest = [...jobs]
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))
    .find((job) => job.youtube_status || job.youtube_error || job.error_message || job.youtube_url);
  if (!latest || latest.youtube_url) return false;
  const text = `${latest.youtube_status || ""} ${latest.youtube_error || ""} ${latest.error_message || ""}`;
  return /invalid_grant|refresh token|reconnect/i.test(text);
}

function platformItem(label, envEnabled, stats, key, forcedValue = "", enabledValue = "on") {
  if (forcedValue) return [label, false, forcedValue];
  const activity = platformActivity(stats.jobs, key);
  if (activity.active) {
    return [label, true, envEnabled ? activity.value : "via Action"];
  }
  return [label, envEnabled, envEnabled ? enabledValue : "off"];
}

function renderTtsConfig(cfg) {
  if (!els.ttsBadge) return;
  const enabled = cfg.thumbnailTtsEnabled !== false;
  const provider = cfg.thumbnailTtsProvider || "deepgram";
  const speed = cfg.thumbnailTtsSpeed || (provider === "openai" ? "1.12" : "1.5");
  const volume = cfg.thumbnailTtsVolume || "1.85";
  const accent = cfg.thumbnailTtsAccentProfile || "id";
  const ipa = provider === "deepgram" && cfg.thumbnailTtsPronunciationEnabled !== false ? " IPA" : "";
  const voice = cfg.thumbnailTtsVoice ? ` / ${cfg.thumbnailTtsVoice}` : "";
  const fallback = cfg.thumbnailTtsFallbackProvider ? ` > ${cfg.thumbnailTtsFallbackProvider}` : "";
  els.ttsBadge.textContent = enabled ? `${provider}${fallback} / ${cfg.thumbnailTtsModel || "TTS"}${voice} / ${accent}${ipa} @${speed}x / vol ${volume}x` : "Off";
  els.ttsBadge.classList.toggle("warn", !enabled);
}

function renderLatestVideoPreview(jobs = []) {
  if (!els.latestVideoPreview) return;
  latestVideoJob = latestPostedVideoJob(jobs);
  if (!latestVideoJob) {
    els.latestVideoBadge.textContent = "Kosong";
    els.latestVideoPreview.innerHTML = `
      <div class="emptyLatest">
        <strong>Belum ada video public.</strong>
        <span>Video akan muncul setelah pipeline upload hasil MP4 ke storage.</span>
      </div>
    `;
    return;
  }

  const title = latestVideoJob.thumbnail_text || latestVideoJob.source_title || latestVideoJob.job_id || "Video terakhir";
  const videoUrl = latestVideoJob.public_video_url || "";
  const thumbnailUrl = latestVideoJob.public_thumbnail_url || "";
  const instagramStatus = latestVideoJob.instagram_media_id
    ? "published"
    : latestVideoJob.instagram_status || "belum dipost";
  const postedAt = formatDateTime(latestVideoJob.published_at || latestVideoJob.updated_at || latestVideoJob.created_at);
  els.latestVideoBadge.textContent = postedAt;
  els.latestVideoPreview.innerHTML = `
    <div class="latestVideoFrame">
      <video src="${escapeAttr(videoUrl)}" poster="${escapeAttr(thumbnailUrl)}" controls preload="metadata" playsinline></video>
    </div>
    <div class="latestVideoInfo">
      <strong>${escapeHtml(short(title, 90))}</strong>
      <p>${escapeHtml(short(latestVideoJob.caption || latestVideoJob.error_message || "Siap dipreview dan diunduh.", 180))}</p>
      <div class="latestVideoMeta">
        <span>${pill(latestVideoJob.publish_status || latestVideoJob.status || "ready")}</span>
        <span>IG: ${escapeHtml(instagramStatus)}</span>
        <span>${escapeHtml(latestVideoJob.job_id || "")}</span>
      </div>
      <div class="latestVideoActions">
        <a class="btn primary small" href="${escapeAttr(videoUrl)}" download="${escapeAttr(videoDownloadName(latestVideoJob))}" target="_blank" rel="noreferrer">Unduh MP4</a>
        ${thumbnailUrl ? `<a class="btn ghost small" href="${escapeAttr(thumbnailUrl)}" target="_blank" rel="noreferrer">Thumbnail</a>` : ""}
        <button id="introPreviewBtn" class="btn ghost small" type="button">Uji TTS+Video</button>
        <button id="instagramDemoBtn" class="btn ghost small" type="button">Uji Post IG</button>
      </div>
      <p id="instagramDemoStatus" class="subtle">${escapeHtml(latestVideoJob.instagram_error || "")}</p>
    </div>
  `;
}

function platformActivity(jobs = [], key) {
  const idKeys = {
    instagram: ["instagram_media_id"],
    facebook: ["facebook_video_id", "facebook_post_id", "facebook_url"],
    youtube: ["youtube_video_id", "youtube_url"],
    tiktok: ["tiktok_publish_id"],
    threads: ["threads_media_id", "threads_url"]
  };
  const statusKey = `${key}_status`;
  const activeStatuses = new Set(["published", "submitted", "processing", "queued"]);
  const sorted = [...jobs].sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
  const match = sorted.find((job) => {
    const hasId = (idKeys[key] || []).some((field) => Boolean(job[field]));
    const status = String(job[statusKey] || "").toLowerCase();
    return hasId || activeStatuses.has(status);
  });
  if (!match) return { active: false, value: "off" };
  const status = String(match[statusKey] || "").toLowerCase();
  if (status === "submitted") return { active: true, value: "submitted" };
  if (status === "queued") return { active: true, value: "queued" };
  if (status === "processing") return { active: true, value: "processing" };
  return { active: true, value: "active" };
}

function renderConsole(run) {
  const logs = run?.logs || [];
  els.consoleMeta.textContent = `${logs.length} log`;
  els.consoleOutput.innerHTML = logs.length
    ? logs.map((item) => {
      const level = String(item.level || "system").toLowerCase();
      return `<span class="ts">[${escapeHtml(formatTime(item.at) || "--:--:--")}]</span> <span class="lvl-${escapeAttr(level)}">${escapeHtml(level.toUpperCase())}</span> ${escapeHtml(item.text || "")}`;
    }).join("\n")
    : "Belum ada output.";
  els.consoleOutput.scrollTop = els.consoleOutput.scrollHeight;
}

function renderVideos(videos) {
  cachedVideos = videos;
  const baseVisible = videos.filter(isQueuePanelVideo);
  const filter = els.videoFilter?.value || "active";
  const visible = filterVideos(filter === "all" ? videos : baseVisible);
  const shown = Math.min(videoLimit, visible.length);
  els.videoCount.textContent = `${shown}/${visible.length} tampil`;
  els.videoRows.innerHTML = [...visible]
    .reverse()
    .slice(0, videoLimit)
    .map((video) => `
      <tr>
        <td data-label="Status">${pill(video.status || "queued")}</td>
        <td data-label="Video">${escapeHtml(short(video.source_title || video.theme || video.id, 56))}</td>
        <td data-label="Target">${escapeHtml(video.target_date || "-")}</td>
        <td data-label="Source">${escapeHtml(video.discovery_source || "manual")}</td>
        <td data-label="URL"><a href="${escapeAttr(video.url || video.source_url || "#")}" target="_blank" rel="noreferrer">${escapeHtml(short(video.url || video.source_url || "-", 46))}</a></td>
      </tr>
    `).join("") || `<tr><td colspan="5" class="emptyRow">Belum ada link.</td></tr>`;
  toggleMoreButton(els.videosMore, visible.length, videoLimit);
  updateResetQueueButton(videos);
}

function renderJobs(jobs) {
  cachedJobs = jobs;
  const visible = filterJobs(jobs);
  const shown = Math.min(jobLimit, visible.length);
  els.jobCount.textContent = `${shown}/${visible.length} tampil`;
  els.jobRows.innerHTML = [...visible]
    .reverse()
    .slice(0, jobLimit)
    .map((job) => `
      <tr>
        <td data-label="Status">${pill(job.status || "pending")}</td>
        <td data-label="Job">${escapeHtml(short(job.job_id || "", 28))}</td>
        <td data-label="Publish">${pill(job.publish_status || "-")}</td>
        <td data-label="Platform">${platformSummary(job)}</td>
        <td data-label="Updated">${escapeHtml(formatDateTime(job.updated_at || job.published_at || job.created_at))}</td>
        <td data-label="Error">${escapeHtml(short(job.error_message || job.instagram_error || job.facebook_error || job.youtube_error || job.tiktok_error || job.threads_error || "", 60))}</td>
      </tr>
    `).join("") || `<tr><td colspan="6" class="emptyRow">Belum ada job.</td></tr>`;
  toggleMoreButton(els.jobsMore, jobs.length, jobLimit);
}

function platformSummary(job) {
  const items = [
    ["IG", job.instagram_status],
    ["FB", job.facebook_status],
    ["YT", job.youtube_status],
    ["TT", job.tiktok_status],
    ["TH", job.threads_status]
  ];
  return items.map(([label, status]) => `<span title="${escapeAttr(status || "-")}">${label}:${escapeHtml(short(status || "-", 10))}</span>`).join(" ");
}

function updateResetQueueButton(videos) {
  if (!els.resetQueueBtn) return;
  const staleCount = videos.filter(isStaleAutoQueue).length;
  els.resetQueueBtn.disabled = staleCount === 0;
  els.resetQueueBtn.textContent = staleCount ? `Reset Queue Lama (${staleCount})` : "Reset Queue Lama";
}

function isQueuePanelVideo(video) {
  const status = video.status || "queued";
  return !["expired", "published", "skipped_duplicate", "published_partial"].includes(status);
}

function setSubmittersDisabled(disabled) {
  for (const form of [els.runForm, els.videoForm]) {
    if (!form) continue;
    const button = form.querySelector('button[type="submit"]');
    if (!button) continue;
    if (disabled) {
      if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
      button.disabled = true;
      button.classList.add("isBusy");
      button.textContent = "Workflow berjalan...";
    } else {
      button.disabled = false;
      button.classList.remove("isBusy");
      if (button.dataset.originalText) {
        button.textContent = button.dataset.originalText;
        delete button.dataset.originalText;
      }
    }
  }
}

function applyEffectDefaults(cfg) {
  effectDefaults = {
    use_frame: Boolean(cfg.videoFrameEnabled),
    use_filter: Boolean(cfg.videoFilterEnabled),
    use_watermark: Boolean(cfg.videoWatermarkEnabled),
    use_music: Boolean(cfg.backgroundMusicEnabled),
    use_subtitle_highlight: Boolean(cfg.subtitleHighlightEnabled)
  };
  if (effectDefaultsApplied) return;
  for (const form of [els.runForm, els.videoForm]) {
    if (!form) continue;
    for (const [key, value] of Object.entries(effectDefaults)) {
      if (form.elements[key]) form.elements[key].checked = value;
    }
  }
  effectDefaultsApplied = true;
}

function readEffectOptions(form) {
  return {
    use_frame: Boolean(form.elements.use_frame?.checked),
    use_filter: Boolean(form.elements.use_filter?.checked),
    use_watermark: Boolean(form.elements.use_watermark?.checked),
    use_music: Boolean(form.elements.use_music?.checked),
    use_subtitle_highlight: Boolean(form.elements.use_subtitle_highlight?.checked)
  };
}

function filterVideos(videos) {
  const query = String(els.videoSearch?.value || "").trim().toLowerCase();
  const filter = els.videoFilter?.value || "active";
  return videos.filter((video) => {
    const status = String(video.status || "queued").toLowerCase();
    if (filter !== "active" && filter !== "all" && status !== filter) return false;
    if (!query) return true;
    return [
      video.id,
      video.source_title,
      video.theme,
      video.url,
      video.source_url,
      video.discovery_source,
      video.discovery_query
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function filterJobs(jobs) {
  const query = String(els.jobSearch?.value || "").trim().toLowerCase();
  const filter = els.jobFilter?.value || "all";
  return jobs.filter((job) => {
    if (filter === "published" && !isPublishedJob(job)) return false;
    if (filter === "ready" && !["ready_to_publish", "queued"].includes(job.status) && !["ready_to_publish", "queued"].includes(job.publish_status)) return false;
    if (filter === "warning" && job.publish_status !== "published_with_warnings") return false;
    if (filter === "failed" && !isFailed(job.status) && !isFailed(job.publish_status)) return false;
    if (!query) return true;
    return [
      job.job_id,
      job.video_id,
      job.source_title,
      job.source_url,
      job.status,
      job.publish_status,
      job.error_message,
      job.instagram_error,
      job.facebook_error,
      job.youtube_error,
      job.tiktok_error,
      job.threads_error
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });
}

function resetEffectOptions(form) {
  for (const [key, value] of Object.entries(effectDefaults)) {
    if (form.elements[key]) form.elements[key].checked = value;
  }
}

function formData(form) {
  const raw = Object.fromEntries(new FormData(form).entries());
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value).trim()]));
}

function handleApiError(error, target = els.runDetail) {
  if (error.status === 401 || error.status === 403 || /PIN|AUTO_DASHBOARD_PIN/i.test(error.message)) {
    window.sessionStorage.removeItem("dashboardPin");
    dashboardPin = "";
    showAuth(error.message);
    return;
  }
  if (target) target.textContent = error.message;
}

function showAuth(message = "") {
  authVisible = true;
  document.body.classList.add("authLocked");
  els.authOverlay?.classList.add("active");
  els.authOverlay?.setAttribute("aria-hidden", "false");
  if (els.authError) els.authError.textContent = message;
  window.setTimeout(() => els.authPin?.focus(), 30);
  stopPolling();
}

function hideAuth() {
  if (!authVisible) return;
  authVisible = false;
  document.body.classList.remove("authLocked");
  els.authOverlay?.classList.remove("active");
  els.authOverlay?.setAttribute("aria-hidden", "true");
  if (els.authError) els.authError.textContent = "";
  schedulePoll();
}

function applyFocusMode() {
  document.body.classList.toggle("focusMode", focusMode);
  if (els.focusModeBtn) {
    els.focusModeBtn.textContent = focusMode ? "Focus On" : "Focus";
    els.focusModeBtn.classList.toggle("isActive", focusMode);
  }
}

function schedulePoll() {
  stopPolling();
  const ms = document.hidden || authVisible ? null : lastRunStatus === "running" ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  if (ms === null) return;
  pollTimer = window.setTimeout(async () => {
    try {
      await refresh();
    } catch (error) {
      handleApiError(error);
    } finally {
      schedulePoll();
    }
  }, ms);
}

function stopPolling() {
  if (pollTimer) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function startClock() {
  const tick = () => {
    if (!els.liveClock) return;
    const now = new Date();
    els.liveClock.textContent = now.toLocaleString("id-ID", {
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    updateRunTimer();
  };
  tick();
  window.setInterval(tick, 1000);
}

els.refreshBtn?.addEventListener("click", () => {
  refresh().catch((error) => handleApiError(error));
});

els.preflightBtn?.addEventListener("click", async () => {
  els.runStatus.textContent = "preflight";
  els.runDetail.textContent = "Cek storage, token platform, dan engine.";
  try {
    const report = await api("/api/preflight", { method: "POST", body: "{}" });
    const failed = (report.checks || []).filter((item) => !item.ok && item.required);
    els.runDetail.textContent = failed.length ? `Gagal: ${failed.map((item) => item.name).join(", ")}` : "Preflight OK.";
    els.consoleOutput.textContent = (report.checks || [])
      .map((item) => `${item.ok ? "OK  " : item.required ? "FAIL" : "WARN"} ${item.name}${item.detail ? ` - ${item.detail}` : ""}`)
      .join("\n");
    els.consoleMeta.textContent = `${(report.checks || []).length} check`;
  } catch (error) {
    handleApiError(error);
  }
});

els.videosMore?.addEventListener("click", () => {
  videoLimit = videoLimit > ROW_LIMIT_DEFAULT ? ROW_LIMIT_DEFAULT : ROW_LIMIT_EXPANDED;
  renderVideos(cachedVideos);
});

els.jobsMore?.addEventListener("click", () => {
  jobLimit = jobLimit > ROW_LIMIT_DEFAULT ? ROW_LIMIT_DEFAULT : ROW_LIMIT_EXPANDED;
  renderJobs(cachedJobs);
});

els.focusModeBtn?.addEventListener("click", () => {
  focusMode = !focusMode;
  window.sessionStorage.setItem("dashboardFocusMode", focusMode ? "1" : "0");
  applyFocusMode();
});

els.videoSearch?.addEventListener("input", () => {
  videoLimit = ROW_LIMIT_DEFAULT;
  renderVideos(cachedVideos);
});

els.videoFilter?.addEventListener("change", () => {
  videoLimit = ROW_LIMIT_DEFAULT;
  renderVideos(cachedVideos);
});

els.jobSearch?.addEventListener("input", () => {
  jobLimit = ROW_LIMIT_DEFAULT;
  renderJobs(cachedJobs);
});

els.jobFilter?.addEventListener("change", () => {
  jobLimit = ROW_LIMIT_DEFAULT;
  renderJobs(cachedJobs);
});

els.copyConsoleBtn?.addEventListener("click", async () => {
  const text = els.consoleOutput?.innerText || "";
  if (!text.trim()) return;
  await navigator.clipboard?.writeText(text).catch(() => {});
  const original = els.copyConsoleBtn.textContent;
  els.copyConsoleBtn.textContent = "Copied";
  window.setTimeout(() => {
    els.copyConsoleBtn.textContent = original || "Copy";
  }, 1200);
});

els.resetQueueBtn?.addEventListener("click", async () => {
  const staleCount = cachedVideos.filter(isStaleAutoQueue).length;
  if (!staleCount) return;
  if (!window.confirm(`Reset ${staleCount} queue lama menjadi expired?`)) return;
  els.resetQueueBtn.disabled = true;
  try {
    const result = await api("/api/videos/reset-queue", { method: "POST", body: "{}" });
    els.runDetail.textContent = `Queue lama direset: ${result.expired || 0} expired.`;
    await refresh();
  } catch (error) {
    handleApiError(error);
  }
});

els.youtubeReconnectBtn?.addEventListener("click", async () => {
  const popup = window.open("about:blank", "_blank");
  els.youtubeReconnectBtn.disabled = true;
  els.runStatus.textContent = "oauth";
  els.runDetail.textContent = "Membuka Google OAuth untuk YouTube.";
  try {
    const auth = await api("/api/youtube/auth-url");
    if (popup) popup.location.href = auth.url;
    else window.location.href = auth.url;
    els.runDetail.textContent = `Login YouTube dibuka. Redirect URI: ${auth.redirectUri}`;
    els.consoleOutput.textContent = `YouTube OAuth Redirect URI\n${auth.redirectUri}`;
    els.consoleMeta.textContent = "YouTube OAuth";
  } catch (error) {
    if (popup) popup.close();
    handleApiError(error);
  } finally {
    els.youtubeReconnectBtn.disabled = false;
  }
});

els.ttsTestBtn?.addEventListener("click", async () => {
  const text = els.ttsText?.value.trim() || "Bagian ini bikin semua orang ikut mikir";
  els.ttsTestBtn.disabled = true;
  els.ttsStatus.textContent = "Membuat audio Bahasa Indonesia...";
  try {
    pauseLatestPreviewVideo();
    if (introPreviewAudio) {
      introPreviewAudio.pause();
      introPreviewAudio = null;
    }
    const result = await api("/api/tts-preview", {
      method: "POST",
      body: JSON.stringify({ text })
    });
    const bytes = base64ToBytes(result.audioBase64 || "");
    const blob = new Blob([bytes], { type: result.mimeType || "audio/mpeg" });
    if (ttsAudioUrl) URL.revokeObjectURL(ttsAudioUrl);
    ttsAudioUrl = URL.createObjectURL(blob);
    els.ttsAudio.src = ttsAudioUrl;
    els.ttsAudio.hidden = false;
    const provider = result.provider || "deepgram";
    const fallback = result.fallbackFrom ? ` fallback dari ${result.fallbackFrom}` : "";
    const voice = result.voice ? ` / ${result.voice}` : "";
    const key = result.keyIndex ? ` / key ${result.keyIndex}` : "";
    const speed = result.speed || (provider === "deepgram" ? "1.5" : "1.12");
    els.ttsStatus.textContent = `${provider}${fallback} / ${result.model || "TTS"}${voice}${key} / ${speed}x / vol ${result.volume || "1.85"}x / ${result.charCount || text.length} karakter`;
    await playAudioWithTtsGain(els.ttsAudio, result.volume).catch(() => {});
  } catch (error) {
    handleApiError(error, els.ttsStatus);
  } finally {
    els.ttsTestBtn.disabled = false;
  }
});

els.latestVideoPreview?.addEventListener("click", async (event) => {
  const introButton = event.target.closest("#introPreviewBtn");
  if (introButton && latestVideoJob) {
    await playIntroVideoPreview(introButton);
    return;
  }

  const button = event.target.closest("#instagramDemoBtn");
  if (!button || !latestVideoJob) return;
  const title = latestVideoJob.thumbnail_text || latestVideoJob.source_title || latestVideoJob.job_id;
  if (!window.confirm(`Post ulang video terakhir ke Instagram untuk uji coba?\n\n${title || ""}`)) return;
  button.disabled = true;
  const status = document.querySelector("#instagramDemoStatus");
  if (status) status.textContent = "Mengirim ke Instagram...";
  try {
    const result = await api("/api/instagram/demo-publish", {
      method: "POST",
      body: JSON.stringify({ job_id: latestVideoJob.job_id })
    });
    if (status) status.textContent = `Instagram terkirim: ${result.result?.mediaId || result.job_id}`;
    els.runDetail.textContent = `Uji Instagram selesai untuk ${result.job_id}.`;
    await refresh();
  } catch (error) {
    handleApiError(error, status || els.runDetail);
  } finally {
    button.disabled = false;
  }
});

async function playIntroVideoPreview(button) {
  const frame = els.latestVideoPreview?.querySelector(".latestVideoFrame");
  const video = els.latestVideoPreview?.querySelector("video");
  const status = document.querySelector("#instagramDemoStatus");
  if (!frame || !video || !latestVideoJob) return;

  const wasMuted = video.muted;
  button.disabled = true;
  if (status) status.textContent = "Membuat TTS intro...";

  try {
    els.ttsAudio?.pause();
    if (introPreviewAudio) {
      introPreviewAudio.pause();
      introPreviewAudio = null;
    }
    video.pause();
    video.muted = true;
    video.currentTime = 0;

    const title = latestVideoJob.thumbnail_text || latestVideoJob.source_title || "Bagian ini bikin penasaran";
    const result = await api("/api/tts-preview", {
      method: "POST",
      body: JSON.stringify({ text: title })
    });

    const overlay = ensureIntroOverlay(frame, latestVideoJob, result.displayText || title);
    overlay.hidden = false;
    frame.classList.add("playingIntro");

    const bytes = base64ToBytes(result.audioBase64 || "");
    const blob = new Blob([bytes], { type: result.mimeType || "audio/mpeg" });
    if (introPreviewAudioUrl) URL.revokeObjectURL(introPreviewAudioUrl);
    introPreviewAudioUrl = URL.createObjectURL(blob);
    introPreviewAudio = new Audio(introPreviewAudioUrl);

    if (status) {
      const provider = result.provider || "deepgram";
      const fallback = result.fallbackFrom ? ` fallback dari ${result.fallbackFrom}` : "";
      const voice = result.voice ? ` / ${result.voice}` : "";
      const key = result.keyIndex ? ` / key ${result.keyIndex}` : "";
      const speed = result.speed || (provider === "deepgram" ? "1.5" : "1.12");
      status.textContent = `${provider}${fallback} / ${result.model || "TTS"}${voice}${key} / ${speed}x / vol ${result.volume || "1.85"}x`;
    }

    await new Promise((resolve, reject) => {
      introPreviewAudio.addEventListener("ended", resolve, { once: true });
      introPreviewAudio.addEventListener("error", () => reject(new Error("Audio intro gagal diputar.")), { once: true });
      playAudioWithTtsGain(introPreviewAudio, result.volume).catch(reject);
    });

    overlay.hidden = true;
    frame.classList.remove("playingIntro");
    video.currentTime = 0;
    video.muted = wasMuted;
    await video.play().catch(() => {});
    if (status) status.textContent = "Preview TTS+video selesai dibuat.";
  } catch (error) {
    video.muted = wasMuted;
    frame.classList.remove("playingIntro");
    const overlay = frame.querySelector(".introPreviewOverlay");
    if (overlay) overlay.hidden = true;
    handleApiError(error, status || els.runDetail);
  } finally {
    button.disabled = false;
  }
}

function pauseLatestPreviewVideo() {
  const video = els.latestVideoPreview?.querySelector("video");
  if (!video) return;
  video.pause();
}

async function playAudioWithTtsGain(audio, value) {
  const gain = normalizeTtsGain(value);
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass || gain <= 1.01) {
    audio.volume = Math.min(1, gain);
    return audio.play();
  }

  if (!ttsAudioContext) ttsAudioContext = new AudioContextClass();
  let gainNode = ttsGainNodes.get(audio);
  if (!gainNode) {
    const source = ttsAudioContext.createMediaElementSource(audio);
    gainNode = ttsAudioContext.createGain();
    source.connect(gainNode);
    gainNode.connect(ttsAudioContext.destination);
    ttsGainNodes.set(audio, gainNode);
  }
  gainNode.gain.value = gain;
  await ttsAudioContext.resume();
  return audio.play();
}

function normalizeTtsGain(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 1.85;
  return Math.min(2.2, Math.max(0.5, number));
}

function ensureIntroOverlay(frame, job, speechText) {
  let overlay = frame.querySelector(".introPreviewOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "introPreviewOverlay";
    frame.appendChild(overlay);
  }
  const thumbnail = job.public_thumbnail_url || "";
  overlay.innerHTML = `
    ${thumbnail ? `<img src="${escapeAttr(thumbnail)}" alt="">` : ""}
    <div>
      <strong>${escapeHtml(short(job.thumbnail_text || job.source_title || "Thumbnail", 70))}</strong>
      <span>${escapeHtml(short(speechText, 120))}</span>
    </div>
  `;
  return overlay;
}

els.videoForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSubmittersDisabled(true);
  try {
    const payload = formData(els.videoForm);
    payload.priority = Number(payload.priority || 1);
    payload.clip_count = Number(payload.clip_count || 1);
    Object.assign(payload, readEffectOptions(els.videoForm));
    await api("/api/videos", { method: "POST", body: JSON.stringify(payload) });
    els.videoForm.reset();
    els.videoForm.elements.theme.value = "podcast artis";
    els.videoForm.elements.priority.value = "1";
    els.videoForm.elements.quality_profile.value = "standard";
    if (els.videoForm.elements.scene_mode) els.videoForm.elements.scene_mode.value = "podcast";
    if (els.videoForm.elements.clip_count) els.videoForm.elements.clip_count.value = "1";
    resetEffectOptions(els.videoForm);
    await refresh();
  } catch (error) {
    setSubmittersDisabled(false);
    handleApiError(error);
  }
});

els.runForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSubmittersDisabled(true);
  try {
    const payload = formData(els.runForm);
    payload.publish = Boolean(els.runForm.elements.publish?.checked);
    payload.clip_count = Number(payload.clip_count || 1);
    Object.assign(payload, readEffectOptions(els.runForm));
    await api("/api/run", { method: "POST", body: JSON.stringify(payload) });
    await refresh();
  } catch (error) {
    setSubmittersDisabled(false);
    handleApiError(error);
  }
});

els.authForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = els.authPin.value.trim();
  if (!pin) {
    els.authError.textContent = "PIN wajib diisi.";
    return;
  }
  try {
    await api("/api/auth", { method: "POST", body: JSON.stringify({ pin }) });
    dashboardPin = pin;
    window.sessionStorage.setItem("dashboardPin", pin);
    hideAuth();
    await refresh();
  } catch (error) {
    els.authError.textContent = error.message;
  }
});

els.logoutBtn?.addEventListener("click", async () => {
  window.sessionStorage.removeItem("dashboardPin");
  dashboardPin = "";
  await api("/api/auth", { method: "DELETE" }).catch(() => {});
  showAuth("Anda sudah keluar.");
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
    return;
  }
  if (authVisible) return;
  refresh().catch((error) => handleApiError(error));
  schedulePoll();
});

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type !== "youtube-reconnect") return;
  els.runStatus.textContent = event.data.ok ? "connected" : "oauth failed";
  els.runDetail.textContent = event.data.ok
    ? "YouTube tersambung ulang. Jalankan Preflight untuk cek token."
    : "Reconnect YouTube gagal. Lihat tab OAuth.";
  refresh().catch((error) => handleApiError(error));
});

startClock();
applyFocusMode();
refresh().catch((error) => handleApiError(error));

function effectSummary(cfg) {
  const items = [];
  if (cfg.videoFrameEnabled) items.push("frame");
  if (cfg.videoFilterEnabled) items.push("filter");
  if (cfg.videoWatermarkEnabled) items.push("wm");
  if (cfg.videoLowerThirdEnabled) items.push("quote");
  if (cfg.backgroundMusicEnabled) items.push("music");
  return items.length ? items.join("+") : "manual";
}

function pill(status) {
  const label = status || "queued";
  const safe = String(label).replace(/[^a-z0-9_-]/gi, "_");
  return `<span class="pill ${escapeAttr(safe)}">${escapeHtml(label)}</span>`;
}

function stepState(failed, active, done, muted = false) {
  if (failed) return "failed";
  if (active) return "active";
  if (done) return "done";
  if (muted) return "muted";
  return "pending";
}

function mapStepState(step) {
  if (step.status === "completed") {
    if (["failure", "cancelled"].includes(step.conclusion)) return "failed";
    if (step.conclusion === "skipped") return "muted";
    return "done";
  }
  if (step.status === "in_progress") return "active";
  return "pending";
}

function isActive(job, statuses) {
  return statuses.includes(job.status) || statuses.includes(job.clipper_status);
}

function currentJob(state) {
  const jobs = state.jobs || [];
  const activeRun = state.activeRun || null;
  if (activeRun?.result?.job_id) {
    const match = jobs.find((job) => job.job_id === activeRun.result.job_id);
    if (match) return match;
  }
  return [...jobs].sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0] || null;
}

function latestPostedVideoJob(jobs = []) {
  return [...jobs]
    .filter((job) => job.public_video_url)
    .sort((a, b) => {
      const left = String(a.published_at || a.updated_at || a.created_at || "");
      const right = String(b.published_at || b.updated_at || b.created_at || "");
      return right.localeCompare(left);
    })[0] || null;
}

function isPublishedJob(job) {
  return job.status === "published" || job.publish_status === "published" || job.publish_status === "published_with_warnings";
}

function isFailed(status) {
  return String(status || "").toLowerCase().includes("failed");
}

function isStaleAutoQueue(video) {
  if (!["queued", "failed", "retry"].includes(video.status || "queued")) return false;
  if (!isAutoDiscoveredVideo(video)) return false;
  return Boolean(video.target_date) && video.target_date < todayIsoDate();
}

function isAutoDiscoveredVideo(video) {
  return Boolean(
    video?.discovery_source ||
      video?.discovery_query ||
      String(video?.notes || "").startsWith("Auto discovery:")
  );
}

function publishedCountForDate(date, history, jobs) {
  const fromHistory = history.filter((entry) => entry.status === "published" && entryDate(entry) === date).length;
  if (fromHistory) return fromHistory;
  return jobs.filter((job) => isPublishedJob(job) && dateKey(job.published_at || job.updated_at || job.created_at) === date).length;
}

function youtubePublishedCountForDate(date, history, jobs) {
  const fromHistory = new Set(
    history
      .filter((entry) => entry.status === "published" && entryDate(entry) === date)
      .filter((entry) => entry.youtube_url || entry.youtube_video_id)
      .map((entry) => entry.youtube_url || entry.youtube_video_id)
  );
  if (fromHistory.size) return fromHistory.size;
  return new Set(
    jobs
      .filter((job) => job.youtube_url && dateKey(job.youtube_published_at || job.published_at || job.updated_at || job.created_at) === date)
      .map((job) => job.youtube_url)
  ).size;
}

function failedCountForDate(date, jobs) {
  return jobs.filter((job) => isFailed(job.status) && dateKey(job.updated_at || job.created_at) === date).length;
}

function entryDate(entry) {
  return cleanDate(entry.publish_date) || dateKey(entry.published_at || entry.created_at || entry.updated_at);
}

function cleanDate(value) {
  const text = String(value || "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function dateKey(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return localIsoDate(parsed);
}

function todayIsoDate() {
  return localIsoDate(new Date());
}

function lastDays(count) {
  const days = [];
  const base = new Date();
  for (let index = count - 1; index >= 0; index -= 1) {
    const date = new Date(base);
    date.setDate(base.getDate() - index);
    days.push(localIsoDate(date));
  }
  return days;
}

function previousDays(count, offset) {
  const days = [];
  const base = new Date();
  for (let index = offset + count - 1; index >= offset; index -= 1) {
    const date = new Date(base);
    date.setDate(base.getDate() - index);
    days.push(localIsoDate(date));
  }
  return days;
}

function localIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function labelDate(date) {
  return String(date || "").slice(5).replace("-", "/");
}

function durationSeconds(start, end) {
  return Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000));
}

function updateRunTimer() {
  if (!els.runTimer) return;
  const run = latestActiveRun;
  if (!run?.startedAt) {
    els.runTimer.textContent = "00:00";
    els.runTimer.title = "Belum ada proses aktif";
    return;
  }
  const end = run.status === "running" ? new Date().toISOString() : run.finishedAt || new Date().toISOString();
  const seconds = durationSeconds(run.startedAt, end);
  els.runTimer.textContent = formatDurationClock(seconds);
  els.runTimer.title = run.status === "running" ? "Durasi proses berjalan" : "Total durasi proses terakhir";
}

function formatDurationClock(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(rest).padStart(2, "0");
  return hours ? `${String(hours).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatTime(value) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString("id-ID", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function toggleMoreButton(button, total, limit) {
  if (!button) return;
  button.hidden = total <= ROW_LIMIT_DEFAULT;
  if (!button.hidden) button.textContent = limit > ROW_LIMIT_DEFAULT ? "Tampilkan 5 saja" : `Lihat lainnya (${total - ROW_LIMIT_DEFAULT})`;
}

function short(value, length = 54) {
  const text = String(value || "");
  return text.length <= length ? text : `${text.slice(0, length - 1)}...`;
}

function videoDownloadName(job = {}) {
  const label = job.thumbnail_text || job.source_title || job.job_id || "clipper-video";
  const safe = String(label)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "clipper-video";
  return `${safe}.mp4`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function base64ToBytes(value) {
  const raw = window.atob(String(value || ""));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}
