#!/usr/bin/env python3
"""
Dashboard lokal minimal untuk Podcast Clipper Automation.
Tidak bergantung pada GitHub remote; membaca & menulis data JSON lokal,
menjalankan npm script, dan menampilkan status sistem.
"""

import json
import os
import platform
import re
import shutil
import subprocess
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
GENERATED_DIR = ROOT / "generated"
ENV_PATH = ROOT / ".env"


def find_npm():
    """Cari executable npm di PATH; fallback ke nama 'npm'."""
    npm = shutil.which("npm")
    if npm:
        return npm
    # Fallback lokasi umum Windows jika PATH minimal
    candidates = [
        Path(r"C:\Program Files\nodejs\npm.cmd"),
        Path(r"C:\Program Files\nodejs\npm"),
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs" / "npm.cmd",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return "npm"


NPM_CMD = find_npm()
print(f"[dashboard] npm resolved to: {NPM_CMD}", flush=True)

app = Flask(__name__, template_folder="templates", static_folder="static")

# Proses npm yang sedang berjalan {cmd_name: {"process": Popen, "start": iso, "log": [...]}}
_running = {}
_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_json(name, default=None):
    path = DATA_DIR / f"{name}.json"
    if not path.exists():
        return default if default is not None else []
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        return {"error": str(e)}


def save_json(name, data):
    path = DATA_DIR / f"{name}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    return {"ok": True}


def parse_dt(s):
    if not s:
        return None
    try:
        s = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except Exception:
        return None


def today_iso():
    return datetime.now().strftime("%Y-%m-%d")


def parse_env():
    env = {}
    if not ENV_PATH.exists():
        return env
    with open(ENV_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


SENSITIVE_KEYS = {
    "AUTO_DASHBOARD_PIN", "FTP_PASSWORD", "SFTP_PASSWORD", "SFTP_PRIVATE_KEY",
    "SFTP_PASSPHRASE", "INSTAGRAM_ACCESS_TOKEN", "FACEBOOK_PAGE_ACCESS_TOKEN",
    "FACEBOOK_USER_ACCESS_TOKEN", "TIKTOK_CLIENT_SECRET", "TIKTOK_ACCESS_TOKEN",
    "TIKTOK_REFRESH_TOKEN", "META_APP_SECRET", "YOUTUBE_CLIENT_SECRET",
    "YOUTUBE_REFRESH_TOKEN", "YOUTUBE_OAUTH_STATE_SECRET", "OPENAI_API_KEY",
    "OPENAI_TTS_API_KEY", "DEEPGRAM_API_KEY", "DEEPGRAM_API_KEYS",
    "DEEPGRAM_TTS_API_KEY", "DEEPGRAM_TTS_API_KEYS", "YTDLP_COOKIES_TXT"
}


def mask_env(env):
    out = {}
    for k, v in env.items():
        if k in SENSITIVE_KEYS and v:
            out[k] = v[:4] + "***" if len(v) > 6 else "***"
        else:
            out[k] = v
    return out


def build_stats():
    videos = load_json("videos", [])
    jobs = load_json("jobs", [])
    history = load_json("history", [])
    env = parse_env()

    today = today_iso()
    active_videos = [v for v in videos if v.get("status") != "expired"]
    queued = [v for v in active_videos if v.get("status", "queued") == "queued"]
    expired = [v for v in videos if v.get("status") == "expired"]

    published_jobs = [j for j in jobs if "published" in str(j.get("status", "")).lower()]
    failed_jobs = [j for j in jobs if "failed" in str(j.get("status", "")).lower()]
    ready_jobs = [j for j in jobs if j.get("status") in ("ready_to_publish", "queued")]

    def pub_date(j):
        d = parse_dt(j.get("published_at") or j.get("created_at"))
        return d.strftime("%Y-%m-%d") if d else None

    today_published = sum(1 for j in history if j.get("publish_date") == today or
                          (j.get("published_at") or "").startswith(today))

    series = []
    for i in range(6, -1, -1):
        d = (datetime.now() - timedelta(days=i)).strftime("%Y-%m-%d")
        series.append({
            "date": d,
            "published": sum(1 for h in history if h.get("publish_date") == d),
            "failed": sum(1 for j in jobs if pub_date(j) == d and "failed" in str(j.get("status", "")).lower())
        })

    total7 = sum(d["published"] for d in series)

    return {
        "videos_total": len(videos),
        "videos_active": len(active_videos),
        "videos_queued": len(queued),
        "videos_expired": len(expired),
        "jobs_total": len(jobs),
        "jobs_published": len(published_jobs),
        "jobs_failed": len(failed_jobs),
        "jobs_ready": len(ready_jobs),
        "today_published": today_published,
        "series7": series,
        "total7": total7,
        "dry_run": env.get("DRY_RUN", "true").lower() == "true",
        "auto_publish": env.get("AUTO_PUBLISH", "false").lower() == "true",
        "upload_driver": env.get("UPLOAD_DRIVER", "local"),
        "ai_provider": env.get("AI_PROVIDER", "openai"),
        "timezone": env.get("APP_TIMEZONE", "Asia/Jakarta"),
    }


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# API: State & Stats
# ---------------------------------------------------------------------------

@app.route("/api/state")
def api_state():
    return jsonify({
        "stats": build_stats(),
        "videos": load_json("videos", []),
        "jobs": load_json("jobs", []),
        "history": load_json("history", []),
        "themes": load_json("themes", []),
        "prompts": load_json("prompts", []),
        "running": {k: {"start": v["start"], "cmd": v["cmd"], "log": v["log"][-50:]}
                    for k, v in _running.items()}
    })


@app.route("/api/stats")
def api_stats():
    return jsonify(build_stats())


# ---------------------------------------------------------------------------
# API: Videos (queue)
# ---------------------------------------------------------------------------

@app.route("/api/videos", methods=["GET", "POST"])
def api_videos():
    videos = load_json("videos", [])
    if request.method == "GET":
        videos = sorted(videos, key=lambda v: parse_dt(v.get("created_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc), reverse=True)
        return jsonify(videos)

    data = request.get_json(force=True) or {}
    if not data.get("url"):
        return jsonify({"error": "URL wajib diisi"}), 400

    now = datetime.now().isoformat()
    new_video = {
        "id": f"video_{datetime.now().strftime('%Y%m%d%H%M%S')}_{os.urandom(2).hex()}",
        "url": data["url"].strip(),
        "theme": data.get("theme", "podcast artis").strip(),
        "target_date": data.get("target_date", ""),
        "status": "queued",
        "created_at": now,
        "updated_at": now,
        "source_title": data.get("title", ""),
        "notes": data.get("notes", "")
    }
    videos.insert(0, new_video)
    save_json("videos", videos)
    return jsonify(new_video)


@app.route("/api/videos/<vid>", methods=["PATCH", "DELETE"])
def api_video(vid):
    videos = load_json("videos", [])
    idx = next((i for i, v in enumerate(videos) if v.get("id") == vid), None)
    if idx is None:
        return jsonify({"error": "Video tidak ditemukan"}), 404

    if request.method == "DELETE":
        videos.pop(idx)
        save_json("videos", videos)
        return jsonify({"ok": True})

    data = request.get_json(force=True) or {}
    allowed = {"status", "theme", "target_date", "notes", "source_title"}
    for k, v in data.items():
        if k in allowed:
            videos[idx][k] = v
    videos[idx]["updated_at"] = datetime.now().isoformat()
    save_json("videos", videos)
    return jsonify(videos[idx])


# ---------------------------------------------------------------------------
# API: Jobs
# ---------------------------------------------------------------------------

@app.route("/api/jobs")
def api_jobs():
    jobs = load_json("jobs", [])
    q = request.args.get("q", "").lower()
    status = request.args.get("status", "")
    if q or status:
        jobs = [j for j in jobs
                if (q in (j.get("source_title") or "").lower() or
                    q in (j.get("source_url") or "").lower() or
                    q in (j.get("job_id") or "").lower())
                and (not status or status in str(j.get("status", "")).lower())]
    jobs = sorted(jobs, key=lambda j: parse_dt(j.get("updated_at") or j.get("created_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc), reverse=True)
    return jsonify(jobs[:200])


@app.route("/api/jobs/<job_id>/retry", methods=["POST"])
def api_job_retry(job_id):
    jobs = load_json("jobs", [])
    for j in jobs:
        if j.get("job_id") == job_id:
            j["status"] = "queued"
            j["error_message"] = ""
            j["updated_at"] = datetime.now().isoformat()
            save_json("jobs", jobs)
            return jsonify({"ok": True})
    return jsonify({"error": "Job tidak ditemukan"}), 404


# ---------------------------------------------------------------------------
# API: History
# ---------------------------------------------------------------------------

@app.route("/api/history")
def api_history():
    history = load_json("history", [])

    def _hist_key(h):
        return parse_dt(h.get("published_at") or h.get("recorded_at") or h.get("publish_date")) or datetime(1970, 1, 1, tzinfo=timezone.utc)

    history = sorted(history, key=_hist_key, reverse=True)
    return jsonify(history[:100])


# ---------------------------------------------------------------------------
# API: Run commands
# ---------------------------------------------------------------------------

def _stream(cmd_name, cmd_list, cwd):
    with _lock:
        if cmd_name in _running:
            return

    is_win = platform.system() == "Windows"
    if is_win:
        # Jalankan via cmd /c agar .cmd/.bat dieksekusi dengan benar.
        # Gabungkan argumen dengan quoting agar path dengan spasi tetap utuh.
        cmd_exe = os.environ.get("COMSPEC", r"C:\Windows\system32\cmd.exe")
        cmd_line = subprocess.list2cmdline([str(x) for x in cmd_list])
        proc = subprocess.Popen(
            [cmd_exe, "/c", cmd_line],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
    else:
        proc = subprocess.Popen(
            [str(x) for x in cmd_list],
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

    with _lock:
        _running[cmd_name] = {
            "process": proc,
            "cmd": " ".join(str(x) for x in cmd_list),
            "start": datetime.now().isoformat(),
            "log": [f"$ {' '.join(str(x) for x in cmd_list)}"]
        }

    def reader():
        for line in proc.stdout:
            line = line.rstrip()
            with _lock:
                _running[cmd_name]["log"].append(line)
        proc.wait()
        with _lock:
            _running[cmd_name]["log"].append(f"EXIT {proc.returncode}")

    threading.Thread(target=reader, daemon=True).start()


@app.route("/api/run/<cmd>", methods=["POST"])
def api_run(cmd):
    allowed = {
        "check": [NPM_CMD, "run", "check"],
        "dry-run": [NPM_CMD, "run", "dry-run"],
        "run": [NPM_CMD, "run", "run"],
        "publish-ready": [NPM_CMD, "run", "publish:ready"],
        "videos-discover": [NPM_CMD, "run", "videos:discover"],
        "youtube-check": [NPM_CMD, "run", "youtube:check"],
        "instagram-check": [NPM_CMD, "run", "instagram:check"],
        "scheduler": [NPM_CMD, "run", "scheduler"],
    }
    if cmd not in allowed:
        return jsonify({"error": "Perintah tidak dikenal"}), 400
    with _lock:
        if cmd in _running and _running[cmd]["process"].poll() is None:
            return jsonify({"error": "Perintah sedang berjalan"}), 409
        _running.pop(cmd, None)
    _stream(cmd, allowed[cmd], str(ROOT))
    return jsonify({"ok": True, "cmd": cmd})


@app.route("/api/run/<cmd>/status")
def api_run_status(cmd):
    with _lock:
        info = _running.get(cmd)
    if not info:
        return jsonify({"running": False})
    proc = info["process"]
    return jsonify({
        "running": proc.poll() is None,
        "start": info["start"],
        "cmd": info["cmd"],
        "log": info["log"][-200:]
    })


@app.route("/api/run/<cmd>/stop", methods=["POST"])
def api_run_stop(cmd):
    with _lock:
        info = _running.get(cmd)
    if not info:
        return jsonify({"error": "Tidak ada proses"}), 404
    info["process"].terminate()
    return jsonify({"ok": True})


@app.route("/api/run/workflow", methods=["POST"])
def api_run_workflow():
    data = request.get_json(force=True) or {}
    is_win = platform.system() == "Windows"
    cmd_exe = os.environ.get("COMSPEC", r"C:\Windows\system32\cmd.exe")

    node_cmd = shutil.which("node") or "node"
    # node.exe adalah executable asli, tidak perlu cmd /c; dengan shell=False
    # path dengan spasi tetap aman karena kita kirim sebagai list.
    args = [node_cmd, str(ROOT / "src" / "run.js")]

    if data.get("dry_run"):
        args.append("--dry-run")
    if data.get("publish"):
        args.append("--publish")
    if data.get("url"):
        args.extend(["--url", str(data["url"]).strip()])
    if data.get("theme"):
        args.extend(["--theme", str(data["theme"]).strip()])
    if data.get("range"):
        args.extend(["--range", str(data["range"]).strip()])
    if data.get("quality_profile"):
        args.extend(["--quality", str(data["quality_profile"]).strip()])
    if data.get("clip_count"):
        args.extend(["--clip-count", str(int(data["clip_count"]))])

    # boolean flags: true/false/undefined -> only set if explicitly chosen
    for flag, arg in [
        ("use_frame", "--use-frame"),
        ("use_filter", "--use-filter"),
        ("use_watermark", "--use-watermark"),
        ("use_subtitle_highlight", "--subtitle-highlight"),
    ]:
        if flag in data:
            args.extend([arg, "true" if data[flag] else "false"])

    cmd = [str(a) for a in args]

    with _lock:
        if "workflow" in _running and _running["workflow"]["process"].poll() is None:
            return jsonify({"error": "Workflow sedang berjalan"}), 409
        _running.pop("workflow", None)

    proc = subprocess.Popen(
        cmd,
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )

    with _lock:
        _running["workflow"] = {
            "process": proc,
            "cmd": " ".join(str(a) for a in args),
            "start": datetime.now().isoformat(),
            "log": [f"$ {' '.join(str(a) for a in args)}"]
        }

    def reader():
        for line in proc.stdout:
            line = line.rstrip()
            with _lock:
                _running["workflow"]["log"].append(line)
        proc.wait()
        with _lock:
            _running["workflow"]["log"].append(f"EXIT {proc.returncode}")

    threading.Thread(target=reader, daemon=True).start()
    return jsonify({"ok": True, "cmd": "workflow"})


# ---------------------------------------------------------------------------
# API: Settings (.env)
# ---------------------------------------------------------------------------

@app.route("/api/settings")
def api_settings():
    env = parse_env()
    return jsonify({
        "raw": env,
        "masked": mask_env(env),
        "sensitive_keys": sorted(SENSITIVE_KEYS)
    })


@app.route("/api/settings", methods=["POST"])
def api_settings_save():
    data = request.get_json(force=True) or {}
    updates = data.get("updates", {})
    if not isinstance(updates, dict):
        return jsonify({"error": "updates harus objek"}), 400

    env = parse_env()
    env.update(updates)

    lines = []
    if ENV_PATH.exists():
        with open(ENV_PATH, "r", encoding="utf-8") as f:
            for line in f:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    lines.append(line.rstrip("\n"))
                    continue
                if "=" in stripped:
                    k = stripped.split("=", 1)[0].strip()
                    if k not in updates:
                        lines.append(line.rstrip("\n"))

    written = set()
    new_lines = []
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            k = stripped.split("=", 1)[0].strip()
            if k in updates:
                new_lines.append(f"{k}={updates[k]}")
                written.add(k)
                continue
        new_lines.append(line)

    for k, v in updates.items():
        if k not in written:
            new_lines.append(f"{k}={v}")

    with open(ENV_PATH, "w", encoding="utf-8") as f:
        f.write("\n".join(new_lines) + "\n")

    return jsonify({"ok": True, "updated": list(updates.keys())})


# ---------------------------------------------------------------------------
# API: Logs
# ---------------------------------------------------------------------------

@app.route("/api/logs")
def api_logs():
    log_files = []
    for pat in ["*.log", "*.out.log", "*.err.log"]:
        log_files.extend(ROOT.glob(pat))
        log_files.extend(GENERATED_DIR.glob("logs/" + pat))
    log_files = sorted(set(log_files), key=lambda p: p.stat().st_mtime, reverse=True)[:30]
    return jsonify([{"name": p.name, "path": str(p.relative_to(ROOT)), "mtime": p.stat().st_mtime} for p in log_files])


@app.route("/api/logs/<path:name>")
def api_log_view(name):
    path = ROOT / name
    if not path.exists():
        return jsonify({"error": "File tidak ditemukan"}), 404
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    lines = content.splitlines()
    return jsonify({"name": name, "lines": lines[-300:], "total": len(lines)})


# ---------------------------------------------------------------------------
# API: Preflight (gunakan npm run check)
# ---------------------------------------------------------------------------

@app.route("/api/preflight", methods=["POST"])
def api_preflight():
    try:
        is_win = platform.system() == "Windows"
        cmd_exe = os.environ.get("COMSPEC", r"C:\Windows\system32\cmd.exe")
        cmd = [cmd_exe, "/c", NPM_CMD, "run", "check"] if is_win else [NPM_CMD, "run", "check"]
        result = subprocess.run(
            cmd,
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            timeout=120,
        )
        return jsonify({
            "ok": result.returncode == 0,
            "returncode": result.returncode,
            "stdout": result.stdout.splitlines(),
            "stderr": result.stderr.splitlines()
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    env = parse_env()
    port = int(env.get("LOCAL_PORT", 8788))
    app.run(host="127.0.0.1", port=port, debug=False)
