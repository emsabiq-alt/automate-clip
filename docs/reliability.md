# Reliability Notes

This project keeps the reliability changes small and non-breaking. The workflow, JSON storage, remote upload fallback, and platform publishing flow are still the same by default.

## JSON Backups

`writeJson()` writes state through the existing temp-file plus rename flow. Before the target JSON file is replaced, the previous file is copied to `data/.backups/` when the file is one of the known state files:

- `themes.json`
- `videos.json`
- `prompts.json`
- `jobs.json`
- `history.json`
- `discovery-cache.json`
- `youtube-quota.json`

Backup names include the original filename and a timestamp. The system keeps the latest 10 backups per file. Backup failures are warnings only and do not stop the workflow.

Generated videos, thumbnails, metadata assets, cookies, `.env`, tokens, and secret files are not backed up by this helper.

## JSON Recovery

`recoverJson(name)` is exported from `src/storage.js`. It is manual only; the workflow never runs it automatically.

Example:

```js
import { recoverJson } from "./src/storage.js";

const result = await recoverJson("jobs");
console.log(result);
```

The helper scans the newest backups first, skips invalid JSON, and restores the latest parseable backup with a temp-file plus rename write.

## Diagnostic Logs

Workflow failures now write best-effort diagnostic JSON files under `generated/logs/`.

Diagnostics include job/video identifiers, source URL, stage, status, error message, safe environment mode flags, selected platform statuses, relevant file paths, preflight summary when available, Node version, platform, and cwd.

Diagnostics intentionally exclude tokens, refresh tokens, cookies, `.env` values, and other secrets.

## SAFE_PUBLISH_MODE

`SAFE_PUBLISH_MODE` can narrow platform publishing without changing the existing `AUTO_PUBLISH` or `DRY_RUN` behavior.

- empty or `all`: current behavior
- `youtube_only`: only YouTube is attempted
- `social_only`: Facebook, Instagram, TikTok, and Threads are allowed; YouTube is skipped
- `none`: no platform publishing is attempted, leaving jobs in ready/dry-run style states

Existing per-platform enabled flags still apply. When a platform is skipped because of safe publish mode, the workflow writes a clear log entry.

## Tests

Run the built-in Node test suite:

```bash
npm test
```

The tests use temporary directories and pure helpers. They do not call external APIs, SFTP/FTP, yt-dlp, FFmpeg, Python, or generated media files.

## Intentionally Not Changed

- No database migration
- No framework rewrite
- No new paid services
- No new publishing platforms
- No more aggressive preflight blocking
- No change to the default publish behavior when `SAFE_PUBLISH_MODE` is empty or `all`
