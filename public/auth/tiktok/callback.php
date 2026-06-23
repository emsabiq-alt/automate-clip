<?php
session_start();

$defaultRedirectUri = 'https://clipper.emsa.pro/auth/tiktok/callback.php';
$dashboardUrl = 'https://clipper.emsa.pro/login-tiktok.php';
$config = [
  'client_key' => getenv('TIKTOK_CLIENT_KEY') ?: '',
  'client_secret' => getenv('TIKTOK_CLIENT_SECRET') ?: '',
  'redirect_uri' => getenv('TIKTOK_REDIRECT_URI') ?: $defaultRedirectUri,
  'scopes' => getenv('TIKTOK_AUTH_SCOPES') ?: 'user.info.basic,video.upload,video.publish',
];

$configFile = __DIR__ . '/../../site/config/tiktok-sandbox.php';
if (is_file($configFile)) {
  $loadedConfig = include $configFile;
  if (is_array($loadedConfig)) {
    $config = array_merge($config, $loadedConfig);
  }
}

$code = isset($_GET['code']) ? trim($_GET['code']) : '';
$state = isset($_GET['state']) ? trim($_GET['state']) : '';
$error = isset($_GET['error']) ? trim($_GET['error']) : '';
$errorDescription = isset($_GET['error_description']) ? trim($_GET['error_description']) : '';
$token = null;
$tokenExport = '';
$exchangeError = '';

function e($value) {
  return htmlspecialchars((string) $value, ENT_QUOTES, 'UTF-8');
}

function mask_value($value) {
  $text = (string) $value;
  if ($text === '') return 'empty';
  return substr($text, 0, 6) . '...' . substr($text, -4);
}

function curl_form($url, $fields) {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query($fields),
    CURLOPT_HTTPHEADER => [
      'Content-Type: application/x-www-form-urlencoded',
      'Cache-Control: no-cache',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 60,
  ]);
  $raw = curl_exec($ch);
  $curlError = curl_error($ch);
  $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  curl_close($ch);
  if ($raw === false) throw new Exception('TikTok OAuth curl error: ' . $curlError);
  $data = json_decode($raw, true);
  if (!is_array($data)) throw new Exception('TikTok OAuth returned non JSON response: ' . substr($raw, 0, 300));
  if ($status >= 400 || isset($data['error']) || isset($data['error_code'])) {
    $detail = $data['error_description']
      ?? ($data['error']['message'] ?? null)
      ?? ($data['message'] ?? null)
      ?? json_encode($data);
    throw new Exception('TikTok OAuth failed: ' . $detail);
  }
  return $data;
}

function token_export_text($token) {
  if (!is_array($token)) return '';
  $pairs = [
    'TIKTOK_ACCESS_TOKEN' => $token['access_token'] ?? '',
    'TIKTOK_REFRESH_TOKEN' => $token['refresh_token'] ?? '',
    'TIKTOK_OPEN_ID' => $token['open_id'] ?? '',
    'TIKTOK_SCOPE' => $token['scope'] ?? '',
  ];
  $lines = [];
  foreach ($pairs as $key => $value) {
    if ((string) $value !== '') $lines[] = $key . '=' . $value;
  }
  return implode("\n", $lines);
}

if ($code && !$error) {
  try {
    if (!$config['client_key'] || !$config['client_secret']) {
      throw new Exception('TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET belum dikonfigurasi di server.');
    }
    $token = curl_form('https://open.tiktokapis.com/v2/oauth/token/', [
      'client_key' => $config['client_key'],
      'client_secret' => $config['client_secret'],
      'code' => $code,
      'grant_type' => 'authorization_code',
      'redirect_uri' => $config['redirect_uri'],
    ]);
    $_SESSION['tiktok_demo_logged_in'] = true;
    $_SESSION['tiktok_demo_token'] = $token;
    $tokenExport = token_export_text($token);
  } catch (Throwable $caught) {
    $exchangeError = $caught->getMessage();
  }
}
?>
<!doctype html>
<html lang="id">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TikTok Callback Token</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: rgba(255, 255, 255, 0.08);
      --line: rgba(255, 255, 255, 0.16);
      --text: #edf7ff;
      --muted: #a7b7c9;
      --cyan: #34d5e8;
      --ink: #061018;
      --good: #067647;
      --bad: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      background: linear-gradient(145deg, #07111f, #0f2038 52%, #07111f);
      color: var(--text);
      font-family: "Segoe UI", Arial, sans-serif;
    }
    main {
      width: min(900px, calc(100% - 32px));
      margin: 0 auto;
      padding: 44px 0;
    }
    .panel {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 24px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, .28);
    }
    h1 { margin: 0 0 8px; font-size: clamp(30px, 6vw, 54px); line-height: 1; }
    h2 { margin: 24px 0 8px; font-size: 20px; }
    p { line-height: 1.55; color: var(--muted); }
    code, textarea { font-family: Consolas, monospace; }
    textarea {
      width: 100%;
      min-height: 180px;
      resize: vertical;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 14px;
      color: #eaecf0;
      background: #101828;
      font-size: 13px;
      line-height: 1.45;
    }
    .btn {
      appearance: none;
      border: 1px solid var(--cyan);
      border-radius: 8px;
      background: var(--cyan);
      color: var(--ink);
      padding: 11px 15px;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 42px;
      margin-right: 8px;
    }
    .btn.secondary {
      background: transparent;
      color: var(--text);
      border-color: var(--line);
    }
    .notice {
      border-radius: 8px;
      padding: 12px 14px;
      margin: 16px 0;
      font-weight: 700;
    }
    .notice.ok { background: #ecfdf3; color: var(--good); border: 1px solid #abefc6; }
    .notice.err { background: #fef3f2; color: var(--bad); border: 1px solid #fecdca; }
    .meta {
      display: grid;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      overflow-wrap: anywhere;
    }
    .copy-status { color: var(--cyan); font-weight: 700; }
  </style>
</head>
<body>
  <main>
    <section class="panel">
      <h1>TikTok Callback</h1>
      <p>Halaman ini menukar authorization code menjadi token TikTok dan menampilkannya untuk `.env` atau GitHub Secrets.</p>

      <?php if ($error): ?>
        <div class="notice err">Login TikTok gagal: <code><?= e($error) ?></code><?= $errorDescription ? ' - ' . e($errorDescription) : '' ?></div>
      <?php elseif ($exchangeError): ?>
        <div class="notice err"><?= e($exchangeError) ?></div>
        <?php if ($code): ?>
          <h2>Fallback manual</h2>
          <textarea readonly>node src/tiktok-token-fastcheck.js --code "<?= e($code) ?>" --redirect-uri "<?= e($config['redirect_uri']) ?>" --persist-local</textarea>
        <?php endif; ?>
      <?php elseif ($tokenExport): ?>
        <div class="notice ok">Token berhasil dibuat. Copy blok ini ke project Banyaktau dan GitHub/Vercel Secrets.</div>
        <textarea id="tokenExport" readonly><?= e($tokenExport) ?></textarea>
        <p>
          <button class="btn" type="button" id="copyBtn">Copy token</button>
          <a class="btn secondary" href="/login-tiktok.php?connected=1">Buka dashboard TikTok</a>
          <span class="copy-status" id="copyStatus"></span>
        </p>
      <?php elseif ($code): ?>
        <div class="notice err">Authorization code diterima, tetapi token tidak terbentuk.</div>
      <?php else: ?>
        <p>Callback aktif. Pakai URL ini sebagai Redirect URI di TikTok Developer.</p>
      <?php endif; ?>

      <div class="meta">
        <span><strong>Client Key:</strong> <code><?= e(mask_value($config['client_key'])) ?></code></span>
        <span><strong>Redirect URI:</strong> <code><?= e($config['redirect_uri']) ?></code></span>
        <span><strong>Scopes:</strong> <code><?= e($config['scopes']) ?></code></span>
        <?php if ($state): ?><span><strong>State:</strong> <code><?= e($state) ?></code></span><?php endif; ?>
      </div>
    </section>
  </main>
  <script>
    const copyBtn = document.querySelector("#copyBtn");
    copyBtn?.addEventListener("click", async () => {
      const textarea = document.querySelector("#tokenExport");
      const status = document.querySelector("#copyStatus");
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(textarea.value);
      } else {
        document.execCommand("copy");
      }
      status.textContent = "Token disalin.";
    });
  </script>
</body>
</html>
