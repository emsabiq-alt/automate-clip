<?php
$jobs = load_jobs();

if (isset($_GET['download'])) {
  serve_download($jobs, (string) $_GET['download']);
}

$videos = collection_items($jobs);
$totalVideos = count($videos);
$youtubeCount = count(array_filter($videos, function ($item) {
  return !empty($item['youtube_url']);
}));
$captionCount = count(array_filter($videos, function ($item) {
  return trim((string) ($item['caption'] ?? '')) !== '';
}));
$thumbnailCount = count(array_filter($videos, function ($item) {
  return trim((string) ($item['thumbnail_url'] ?? '')) !== '';
}));

function load_jobs() {
  $candidates = [
    __DIR__ . '/ig-generated/state/jobs.json',
    dirname(__DIR__) . '/data/jobs.json',
  ];

  foreach ($candidates as $file) {
    if (!is_file($file)) continue;
    $raw = file_get_contents($file);
    $data = json_decode($raw, true);
    if (is_array($data)) return $data;
  }

  return [];
}

function collection_items($jobs) {
  $items = [];
  $filterExistingFiles = has_video_storage();

  foreach ($jobs as $job) {
    if (!is_array($job) || empty($job['public_video_url'])) continue;
    if ($filterExistingFiles && !local_video_path((string) $job['public_video_url'])) continue;

    $jobId = trim((string) ($job['job_id'] ?? $job['id'] ?? ''));
    if ($jobId === '') $jobId = 'video-' . count($items);

    $updated = first_value($job, ['published_at', 'youtube_published_at', 'updated_at', 'created_at']);
    $title = first_value($job, ['thumbnail_text', 'source_title', 'title', 'selected_angle']);
    if ($title === '') $title = $jobId;

    $items[] = [
      'job_id' => $jobId,
      'title' => $title,
      'caption' => (string) ($job['caption'] ?? ''),
      'video_url' => (string) ($job['public_video_url'] ?? ''),
      'thumbnail_url' => (string) ($job['public_thumbnail_url'] ?? ''),
      'youtube_url' => (string) ($job['youtube_url'] ?? ''),
      'youtube_status' => (string) ($job['youtube_status'] ?? ''),
      'tiktok_status' => (string) ($job['tiktok_status'] ?? ''),
      'instagram_status' => (string) ($job['instagram_status'] ?? ''),
      'publish_status' => (string) ($job['publish_status'] ?? $job['status'] ?? ''),
      'updated_at' => $updated,
      'source_url' => (string) ($job['source_url'] ?? $job['url'] ?? ''),
      'download_url' => '?download=' . rawurlencode($jobId),
      'download_filename' => safe_filename($jobId . '.mp4'),
    ];
  }

  usort($items, function ($a, $b) {
    return strcmp((string) ($b['updated_at'] ?? ''), (string) ($a['updated_at'] ?? ''));
  });

  return $items;
}

function first_value($item, $keys) {
  foreach ($keys as $key) {
    $value = trim((string) ($item[$key] ?? ''));
    if ($value !== '') return $value;
  }
  return '';
}

function serve_download($jobs, $jobId) {
  $jobId = preg_replace('/[^A-Za-z0-9_.-]/', '', $jobId);
  if ($jobId === '') {
    http_response_code(404);
    exit('Video tidak ditemukan.');
  }

  foreach ($jobs as $job) {
    $currentId = trim((string) ($job['job_id'] ?? $job['id'] ?? ''));
    if ($currentId !== $jobId) continue;

    $path = local_video_path((string) ($job['public_video_url'] ?? ''));
    if (!$path || !is_file($path)) {
      http_response_code(404);
      exit('File video belum tersedia di server.');
    }

    $filename = safe_filename($jobId . '.mp4');
    while (ob_get_level()) ob_end_clean();
    header('Content-Type: video/mp4');
    header('Content-Transfer-Encoding: binary');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    header('Content-Length: ' . filesize($path));
    header('Cache-Control: private, max-age=0, must-revalidate');
    readfile($path);
    exit;
  }

  http_response_code(404);
  exit('Video tidak ditemukan.');
}

function local_video_path($videoUrl) {
  $parts = parse_url($videoUrl);
  $path = rawurldecode((string) ($parts['path'] ?? ''));
  if (!starts_with($path, '/ig-generated/videos/')) return '';

  $relative = ltrim(substr($path, strlen('/ig-generated/videos/')), '/');
  if ($relative === '' || strpos($relative, '..') !== false) return '';

  foreach (video_roots() as $root) {
    $candidate = realpath($root . DIRECTORY_SEPARATOR . $relative);
    if (!$candidate) continue;

    $rootWithSep = rtrim($root, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
    if ($candidate === $root || starts_with($candidate, $rootWithSep)) return $candidate;
  }

  return '';
}

function has_video_storage() {
  return count(video_roots()) > 0;
}

function video_roots() {
  static $roots = null;
  if ($roots !== null) return $roots;

  $candidates = [
    __DIR__ . '/ig-generated/videos',
    dirname(__DIR__) . '/ig-generated/videos',
  ];

  $roots = [];
  foreach ($candidates as $candidate) {
    $root = realpath($candidate);
    if ($root && is_dir($root) && !in_array($root, $roots, true)) $roots[] = $root;
  }

  return $roots;
}

function starts_with($value, $prefix) {
  return substr((string) $value, 0, strlen((string) $prefix)) === (string) $prefix;
}

function safe_filename($value) {
  return preg_replace('/[^A-Za-z0-9_.-]/', '-', (string) $value);
}

function e($value) {
  return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function short_text($value, $limit = 150) {
  $text = trim(preg_replace('/\s+/', ' ', (string) $value));
  if ($text === '') return '';
  if (function_exists('mb_strlen') && mb_strlen($text, 'UTF-8') > $limit) {
    return rtrim(mb_substr($text, 0, $limit - 1, 'UTF-8')) . '...';
  }
  if (strlen($text) > $limit) return rtrim(substr($text, 0, $limit - 1)) . '...';
  return $text;
}

function date_label($value) {
  $value = trim((string) $value);
  if ($value === '') return 'Belum bertanggal';
  try {
    $date = new DateTime($value);
    return $date->format('d M Y H:i');
  } catch (Exception $error) {
    return $value;
  }
}

function status_label($item) {
  if (!empty($item['youtube_url'])) return 'YouTube published';
  if (($item['youtube_status'] ?? '') === 'quota_exceeded') return 'YouTube quota';
  if (!empty($item['publish_status'])) return $item['publish_status'];
  return 'ready';
}
?>
<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#090b0f">
    <meta name="robots" content="noindex, follow">
    <title>Clipper Collection</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #090b0f;
        --panel: rgba(20, 24, 30, 0.86);
        --panel-2: rgba(28, 33, 41, 0.92);
        --line: rgba(255, 255, 255, 0.12);
        --line-strong: rgba(255, 255, 255, 0.2);
        --text: #f5f7fb;
        --muted: #aab3c2;
        --faint: #747f91;
        --teal: #2dd4bf;
        --lime: #a3e635;
        --blue: #60a5fa;
        --amber: #fbbf24;
        --rose: #fb7185;
        --violet: #a78bfa;
        --shadow: 0 22px 60px rgba(0, 0, 0, 0.32);
        --radius: 8px;
        --mono: "Cascadia Mono", Consolas, monospace;
      }

      * {
        box-sizing: border-box;
        min-width: 0;
      }

      html,
      body {
        margin: 0;
        min-height: 100%;
        background: var(--bg);
        color: var(--text);
        font-family: "Segoe UI", Arial, sans-serif;
        font-size: 14px;
        line-height: 1.5;
        -webkit-font-smoothing: antialiased;
        text-size-adjust: 100%;
      }

      body {
        background:
          linear-gradient(180deg, rgba(45, 212, 191, 0.1), transparent 360px),
          linear-gradient(135deg, #12161d 0%, #090b0f 52%, #15120e 100%);
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      button,
      input,
      textarea {
        font: inherit;
      }

      button {
        cursor: pointer;
      }

      .bgGrid {
        position: fixed;
        inset: 0;
        z-index: -1;
        pointer-events: none;
        background-image:
          linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
        background-size: 48px 48px;
        mask-image: linear-gradient(#000 0%, rgba(0, 0, 0, 0.74) 42%, transparent 100%);
      }

      .shell {
        width: min(1440px, calc(100% - 28px));
        margin: 0 auto;
        padding: 18px 0 36px;
        display: grid;
        gap: 14px;
      }

      .topbar,
      .hero,
      .toolbar,
      .emptyState {
        border: 1px solid var(--line);
        border-radius: var(--radius);
        background: var(--panel);
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .topbar {
        position: sticky;
        top: 10px;
        z-index: 5;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        padding: 12px 14px;
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .mark,
      .icon {
        display: inline-grid;
        place-items: center;
        flex: 0 0 auto;
        border-radius: 8px;
        font-weight: 900;
        letter-spacing: 0;
      }

      .mark {
        width: 42px;
        height: 42px;
        background: linear-gradient(135deg, var(--teal), var(--lime));
        color: #05110e;
      }

      .kicker {
        margin: 0 0 2px;
        color: var(--teal);
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: 24px;
        line-height: 1.15;
        letter-spacing: 0;
      }

      .topActions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }

      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 16px;
        align-items: end;
        padding: 22px;
      }

      .hero h2 {
        max-width: 820px;
        margin-top: 6px;
        font-size: 30px;
        line-height: 1.1;
        letter-spacing: 0;
      }

      .hero p {
        max-width: 760px;
        margin-top: 10px;
        color: var(--muted);
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(116px, 1fr));
        gap: 8px;
        min-width: min(100%, 520px);
      }

      .stat {
        min-height: 78px;
        display: grid;
        align-content: space-between;
        gap: 8px;
        padding: 11px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.04);
      }

      .stat span {
        color: var(--muted);
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.1em;
        text-transform: uppercase;
      }

      .stat strong {
        color: var(--text);
        font-size: 24px;
        line-height: 1;
      }

      .toolbar {
        display: grid;
        grid-template-columns: minmax(240px, 1fr) auto auto;
        gap: 10px;
        align-items: center;
        padding: 12px;
      }

      .search {
        position: relative;
      }

      .search input {
        width: 100%;
        height: 40px;
        padding: 0 12px 0 40px;
        border: 1px solid var(--line);
        border-radius: 8px;
        outline: 0;
        background: rgba(7, 9, 12, 0.78);
        color: var(--text);
      }

      .search input:focus {
        border-color: rgba(45, 212, 191, 0.62);
        box-shadow: 0 0 0 3px rgba(45, 212, 191, 0.12);
      }

      .search svg {
        position: absolute;
        left: 12px;
        top: 50%;
        width: 17px;
        height: 17px;
        color: var(--faint);
        transform: translateY(-50%);
      }

      .segmented {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      .btn,
      .chip {
        min-height: 36px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        border-radius: 8px;
        border: 1px solid var(--line-strong);
        color: var(--text);
        background: rgba(255, 255, 255, 0.055);
        font-size: 12px;
        font-weight: 850;
        transition: transform 0.15s ease, border-color 0.15s ease, background 0.15s ease;
      }

      .btn {
        padding: 0 12px;
      }

      .chip {
        padding: 0 10px;
      }

      .btn:hover,
      .chip:hover,
      .chip.active {
        transform: translateY(-1px);
        border-color: rgba(45, 212, 191, 0.55);
        background: rgba(45, 212, 191, 0.12);
      }

      .btn.primary {
        border-color: transparent;
        background: linear-gradient(135deg, var(--teal), var(--lime));
        color: #06110e;
      }

      .btn.blue {
        border-color: rgba(96, 165, 250, 0.42);
        background: rgba(96, 165, 250, 0.12);
      }

      .btn.dark {
        border-color: rgba(167, 139, 250, 0.38);
        background: rgba(167, 139, 250, 0.12);
      }

      .btn[disabled] {
        opacity: 0.55;
        cursor: not-allowed;
        transform: none;
      }

      .icon {
        width: 22px;
        height: 22px;
        background: rgba(255, 255, 255, 0.1);
        color: currentColor;
        font-size: 10px;
      }

      .gallery {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 14px;
      }

      .card {
        display: grid;
        gap: 12px;
        padding: 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel-2);
        box-shadow: var(--shadow);
      }

      .videoFrame {
        position: relative;
        overflow: hidden;
        border-radius: 8px;
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: #050608;
        aspect-ratio: 9 / 16;
      }

      .videoFrame video {
        width: 100%;
        height: 100%;
        display: block;
        background: #050608;
        object-fit: contain;
      }

      .badgeRow {
        position: absolute;
        left: 9px;
        right: 9px;
        top: 9px;
        display: flex;
        justify-content: space-between;
        gap: 8px;
        pointer-events: none;
      }

      .badge {
        min-height: 24px;
        display: inline-flex;
        align-items: center;
        padding: 0 8px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 999px;
        background: rgba(5, 6, 8, 0.68);
        color: var(--muted);
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.07em;
        text-transform: uppercase;
        backdrop-filter: blur(10px);
      }

      .badge.good {
        color: var(--lime);
        border-color: rgba(163, 230, 53, 0.35);
      }

      .badge.warn {
        color: var(--amber);
        border-color: rgba(251, 191, 36, 0.35);
      }

      .content {
        display: grid;
        gap: 9px;
      }

      .content h3 {
        font-size: 15px;
        line-height: 1.35;
        letter-spacing: 0;
      }

      .meta {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 7px;
        color: var(--faint);
        font-family: var(--mono);
        font-size: 11px;
      }

      .captionBox {
        display: grid;
        gap: 7px;
      }

      .captionBox textarea {
        width: 100%;
        min-height: 104px;
        resize: vertical;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 8px;
        outline: 0;
        background: rgba(7, 9, 12, 0.78);
        color: #dfe6ef;
        font-size: 12px;
        line-height: 1.5;
      }

      .actionGrid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }

      .actionGrid .wide {
        grid-column: 1 / -1;
      }

      .emptyState {
        padding: 28px;
        text-align: center;
        color: var(--muted);
      }

      .toast {
        position: fixed;
        left: 50%;
        bottom: 18px;
        z-index: 20;
        max-width: calc(100% - 28px);
        padding: 11px 14px;
        border: 1px solid rgba(45, 212, 191, 0.4);
        border-radius: 8px;
        background: rgba(11, 14, 18, 0.94);
        color: var(--text);
        box-shadow: var(--shadow);
        transform: translate(-50%, 130%);
        transition: transform 0.22s ease;
      }

      .toast.show {
        transform: translate(-50%, 0);
      }

      [hidden] {
        display: none !important;
      }

      @media (max-width: 1040px) {
        .hero {
          grid-template-columns: 1fr;
        }

        .stats {
          min-width: 0;
        }

        .toolbar {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 720px) {
        .shell {
          width: 100%;
          padding: 10px;
        }

        .topbar {
          position: static;
          align-items: flex-start;
          flex-direction: column;
        }

        .topActions,
        .topActions .btn {
          width: 100%;
        }

        .hero {
          padding: 16px;
        }

        .hero h2 {
          font-size: 24px;
        }

        .stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .gallery {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 420px) {
        .stats,
        .actionGrid {
          grid-template-columns: 1fr;
        }

        .actionGrid .wide {
          grid-column: auto;
        }
      }
    </style>
  </head>
  <body>
    <div class="bgGrid" aria-hidden="true"></div>
    <main class="shell">
      <header class="topbar">
        <a class="brand" href="/collection.php" aria-label="Clipper Collection">
          <span class="mark">CE</span>
          <span>
            <p class="kicker">Clipper Emsa Pro</p>
            <h1>Collection</h1>
          </span>
        </a>
        <nav class="topActions" aria-label="Collection navigation">
          <a class="btn" href="/">Dashboard</a>
          <a class="btn primary" href="/collection.php">Gallery</a>
        </nav>
      </header>

      <section class="hero">
        <div>
          <p class="kicker">Public Gallery</p>
          <h2>Video siap pakai untuk upload, share, dan arsip koleksi.</h2>
          <p>Semua output yang sudah punya URL publik tampil di sini tanpa login, lengkap dengan poster thumbnail, caption, dan tombol unduh.</p>
        </div>
        <div class="stats" aria-label="Collection summary">
          <article class="stat">
            <span>Total</span>
            <strong><?= e($totalVideos) ?></strong>
          </article>
          <article class="stat">
            <span>Caption</span>
            <strong><?= e($captionCount) ?></strong>
          </article>
          <article class="stat">
            <span>Thumbnail</span>
            <strong><?= e($thumbnailCount) ?></strong>
          </article>
          <article class="stat">
            <span>YouTube</span>
            <strong><?= e($youtubeCount) ?></strong>
          </article>
        </div>
      </section>

      <section class="toolbar" aria-label="Gallery tools">
        <label class="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10.8 18.1a7.3 7.3 0 1 1 0-14.6 7.3 7.3 0 0 1 0 14.6Zm5.2-1.7 4.2 4.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
          <input id="searchInput" type="search" placeholder="Cari judul, caption, atau job ID" autocomplete="off">
        </label>
        <div class="segmented" aria-label="Gallery filter">
          <button class="chip active" type="button" data-filter="all">Semua</button>
          <button class="chip" type="button" data-filter="youtube">YouTube</button>
          <button class="chip" type="button" data-filter="quota">Quota</button>
          <button class="chip" type="button" data-filter="caption">Caption</button>
        </div>
        <span id="resultCount" class="badge"><?= e($totalVideos) ?> video</span>
      </section>

      <?php if (!$videos): ?>
        <section class="emptyState">
          <h2>Belum ada video di koleksi.</h2>
          <p>Video akan muncul setelah workflow menghasilkan `public_video_url` di state jobs.</p>
        </section>
      <?php else: ?>
        <section id="gallery" class="gallery" aria-live="polite">
          <?php foreach ($videos as $item): ?>
            <?php
              $status = status_label($item);
              $hasCaption = trim((string) $item['caption']) !== '';
              $isYoutube = trim((string) $item['youtube_url']) !== '';
              $isQuota = ($item['youtube_status'] ?? '') === 'quota_exceeded';
            ?>
            <article
              class="card"
              data-card
              data-youtube="<?= $isYoutube ? '1' : '0' ?>"
              data-quota="<?= $isQuota ? '1' : '0' ?>"
              data-caption="<?= $hasCaption ? '1' : '0' ?>"
            >
              <div class="videoFrame">
                <video
                  controls
                  playsinline
                  preload="none"
                  <?= $item['thumbnail_url'] !== '' ? 'poster="' . e($item['thumbnail_url']) . '"' : '' ?>
                >
                  <source src="<?= e($item['video_url']) ?>" type="video/mp4">
                </video>
                <div class="badgeRow">
                  <span class="badge <?= $isYoutube ? 'good' : ($isQuota ? 'warn' : '') ?>"><?= e($status) ?></span>
                  <span class="badge"><?= $item['thumbnail_url'] ? 'Poster' : 'Video' ?></span>
                </div>
              </div>

              <div class="content">
                <h3><?= e(short_text($item['title'], 90)) ?></h3>
                <div class="meta">
                  <span><?= e($item['job_id']) ?></span>
                  <span><?= e(date_label($item['updated_at'])) ?></span>
                </div>

                <label class="captionBox">
                  <span class="kicker">Caption</span>
                  <textarea readonly><?= e($item['caption'] ?: 'Caption belum tersedia untuk video ini.') ?></textarea>
                </label>

                <div class="actionGrid">
                  <button class="btn" type="button" data-copy>
                    <span class="icon">CP</span>
                    Copy caption
                  </button>
                  <a class="btn primary" href="<?= e($item['download_url']) ?>" download>
                    <span class="icon">DL</span>
                    Unduh
                  </a>
                  <button
                    class="btn blue"
                    type="button"
                    data-upload="youtube"
                    data-url="https://www.youtube.com/upload"
                    data-file-url="<?= e($item['download_url']) ?>"
                    data-filename="<?= e($item['download_filename']) ?>"
                    data-title="<?= e($item['title']) ?>"
                  >
                    <span class="icon">YT</span>
                    YouTube
                  </button>
                  <button class="btn dark" type="button" data-upload="tiktok" data-url="https://www.tiktok.com/upload?lang=id-ID">
                    <span class="icon">TT</span>
                    TikTok
                  </button>
                  <?php if ($item['youtube_url'] !== ''): ?>
                    <a class="btn wide" href="<?= e($item['youtube_url']) ?>" target="_blank" rel="noreferrer">
                      <span class="icon">GO</span>
                      Buka YouTube
                    </a>
                  <?php endif; ?>
                </div>
              </div>
            </article>
          <?php endforeach; ?>
        </section>
      <?php endif; ?>
    </main>

    <div id="toast" class="toast" role="status" aria-live="polite"></div>

    <script>
      const cards = Array.from(document.querySelectorAll("[data-card]"));
      const searchInput = document.querySelector("#searchInput");
      const chips = Array.from(document.querySelectorAll("[data-filter]"));
      const resultCount = document.querySelector("#resultCount");
      const toast = document.querySelector("#toast");
      let activeFilter = "all";
      let toastTimer = 0;

      function showToast(message) {
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add("show");
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2300);
      }

      async function copyText(text) {
        const value = String(text || "").trim();
        if (!value || value === "Caption belum tersedia untuk video ini.") {
          showToast("Caption belum tersedia.");
          return false;
        }

        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(value);
          return true;
        }

        const temp = document.createElement("textarea");
        temp.value = value;
        temp.setAttribute("readonly", "");
        temp.style.position = "fixed";
        temp.style.left = "-9999px";
        document.body.appendChild(temp);
        temp.select();
        const ok = document.execCommand("copy");
        temp.remove();
        return ok;
      }

      async function copyCaptionFromCard(card) {
        const textarea = card.querySelector("textarea");
        const ok = await copyText(textarea ? textarea.value : "");
        showToast(ok ? "Caption tersalin." : "Caption gagal disalin.");
        return ok;
      }

      async function shareVideoFile(button, card) {
        if (!navigator.share || !navigator.canShare || typeof File === "undefined") return false;

        const fileUrl = button.dataset.fileUrl || "";
        if (!fileUrl) return false;

        showToast("Menyiapkan file video...");
        const response = await fetch(fileUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        const file = new File([blob], button.dataset.filename || "podflask-video.mp4", {
          type: blob.type || "video/mp4"
        });
        const shareFiles = { files: [file] };
        if (!navigator.canShare(shareFiles)) return false;

        const textarea = card?.querySelector("textarea");
        await navigator.share({
          files: [file],
          title: button.dataset.title || "PodFlask video",
          text: textarea ? textarea.value : ""
        });
        return true;
      }

      function applyFilters() {
        const query = (searchInput?.value || "").trim().toLowerCase();
        let shown = 0;
        cards.forEach((card) => {
          const haystack = card.dataset.cachedSearch || (card.dataset.cachedSearch = card.textContent.toLowerCase());
          const searchMatch = !query || haystack.includes(query);
          const filterMatch =
            activeFilter === "all" ||
            (activeFilter === "youtube" && card.dataset.youtube === "1") ||
            (activeFilter === "quota" && card.dataset.quota === "1") ||
            (activeFilter === "caption" && card.dataset.caption === "1");
          const visible = searchMatch && filterMatch;
          card.hidden = !visible;
          if (visible) shown += 1;
        });
        if (resultCount) resultCount.textContent = `${shown} video`;
      }

      document.addEventListener("click", (event) => {
        const copyButton = event.target.closest("[data-copy]");
        if (copyButton) {
          const card = copyButton.closest("[data-card]");
          if (card) copyCaptionFromCard(card);
          return;
        }

        const uploadButton = event.target.closest("[data-upload]");
        if (uploadButton) {
          const card = uploadButton.closest("[data-card]");
          const url = uploadButton.dataset.url || "";
          const platform = uploadButton.dataset.upload || "";
          if (card) copyCaptionFromCard(card);
          if (platform === "youtube") {
            shareVideoFile(uploadButton, card)
              .then((shared) => {
                if (!shared && url) {
                  window.open(url, "_blank", "noopener");
                  showToast("Share file tidak didukung. YouTube upload dibuka.");
                }
              })
              .catch(() => {
                if (url) window.open(url, "_blank", "noopener");
                showToast("Share file gagal. YouTube upload dibuka.");
              });
            return;
          }
          if (url) window.open(url, "_blank", "noopener");
        }
      });

      chips.forEach((chip) => {
        chip.addEventListener("click", () => {
          activeFilter = chip.dataset.filter || "all";
          chips.forEach((item) => item.classList.toggle("active", item === chip));
          applyFilters();
        });
      });

      searchInput?.addEventListener("input", applyFilters);
      applyFilters();
    </script>
  </body>
</html>
