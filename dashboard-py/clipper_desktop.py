#!/usr/bin/env python3
"""
Clipper Desktop - Aplikasi kontrol lokal untuk Podcast Clipper Automation.
Menggunakan CustomTkinter (mirip yt-longform/app/yt_studio.py).

Fitur:
- Ringkasan statistik & trend
- Manajemen queue (tambah/edit/hapus)
- Daftar job dengan filter
- Riwayat publish
- Workflow runner dengan live console
- Editor .env
- Preflight check

Jalankan: python clipper_desktop.py (atau klik shortcut desktop)
"""

import json
import os
import queue
import subprocess
import sys
import threading
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import customtkinter as ctk
from customtkinter.windows.widgets.scaling.scaling_tracker import ScalingTracker
from tkinter import messagebox, ttk

# Patch CustomTkinter scaling tracker agar tidak error di Python/Windows tertentu
_original_check = ScalingTracker.check_dpi_scaling


def _patched_check_dpi_scaling(cls):
    try:
        _original_check()
    except TypeError:
        pass


ScalingTracker.check_dpi_scaling = classmethod(_patched_check_dpi_scaling)

APP_DIR = Path(__file__).resolve().parent
PROJECT_DIR = APP_DIR.parent
ENV_PATH = PROJECT_DIR / ".env"

sys.path.insert(0, str(APP_DIR))
from app import app  # noqa: E402

HOST = "127.0.0.1"
PORT = 8788
BASE_URL = f"http://{HOST}:{PORT}"

COLORS = {
    "bg": "#0b0d10",
    "bg2": "#11131a",
    "panel": "#161922",
    "panel2": "#1e2430",
    "border": "#252b3a",
    "text": "#e2e8f0",
    "muted": "#94a3b8",
    "accent": "#2dd4bf",
    "accent_hover": "#22b8a4",
    "blue": "#38bdf8",
    "ok": "#34d399",
    "err": "#f87171",
    "warn": "#fbbf24",
}

FONT = "Segoe UI"


def start_server():
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)


def wait_for_server(timeout=30):
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(BASE_URL, timeout=1):
                return True
        except Exception:
            time.sleep(0.3)
    return False


def api_get(path):
    try:
        with urllib.request.urlopen(f"{BASE_URL}{path}", timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"error": str(e)}


def api_request(path, data=None, method="POST"):
    body = json.dumps(data or {}).encode("utf-8") if data is not None else None
    req = urllib.request.Request(
        f"{BASE_URL}{path}", data=body,
        headers={"Content-Type": "application/json"} if body else {},
        method=method
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode("utf-8"))
        except Exception:
            return {"error": str(e)}
    except Exception as e:
        return {"error": str(e)}


def api_post(path, data=None):
    return api_request(path, data, "POST")


def parse_dt(s):
    if not s:
        return None
    try:
        s = str(s).replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except Exception:
        return None


def fmt_date(s):
    if not s:
        return "-"
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return dt.strftime("%d %b %Y %H:%M")
    except Exception:
        return str(s)


class ClipperDesktopApp(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Clipper Desktop")
        self.geometry("1400x900")
        self.minsize(1100, 700)
        self.configure(fg_color=COLORS["bg"])
        ctk.set_appearance_mode("dark")

        self.log_queue = queue.Queue()
        self.current_view = None
        self.console_poll_cmd = None
        self.console_poll_after = None
        self.running = True

        self._configure_tree_style()
        self._build_layout()
        self._center_window()
        self.after(100, lambda: (self.deiconify(), self.lift(), self.focus_force()))
        self.show_view("dashboard")
        self._poll_clock()
        self._drain_log()
        self.refresh_data()

    def _center_window(self):
        self.update_idletasks()
        w = self.winfo_width()
        h = self.winfo_height()
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        x = (sw - w) // 2
        y = (sh - h) // 2
        self.geometry(f"{w}x{h}+{x}+{y}")

    def _configure_tree_style(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except Exception:
            pass
        style.configure("Treeview",
                        background=COLORS["panel"],
                        foreground=COLORS["text"],
                        fieldbackground=COLORS["panel"],
                        rowheight=34,
                        font=(FONT, 11),
                        borderwidth=0)
        style.configure("Treeview.Heading",
                        background=COLORS["panel2"],
                        foreground=COLORS["text"],
                        font=(FONT, 11, "bold"),
                        borderwidth=0,
                        padding=8)
        style.map("Treeview",
                  background=[("selected", COLORS["accent"])],
                  foreground=[("selected", "#000")])

    def _build_layout(self):
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)
        self._build_sidebar()
        self._build_main()

    def _build_sidebar(self):
        bar = ctk.CTkFrame(self, width=230, fg_color=COLORS["bg2"], corner_radius=0)
        bar.grid(row=0, column=0, sticky="nsw")
        bar.grid_propagate(False)

        brand = ctk.CTkFrame(bar, fg_color="transparent")
        brand.pack(fill="x", padx=20, pady=(26, 28))
        ctk.CTkLabel(brand, text="▶", font=(FONT, 22, "bold"),
                     text_color=COLORS["accent"]).pack(side="left")
        ctk.CTkLabel(brand, text="  Clipper", font=(FONT, 18, "bold"),
                     text_color=COLORS["text"]).pack(side="left")

        self.nav_buttons = {}
        nav = [
            ("dashboard", "📊  Ringkasan"),
            ("queue", "📥  Queue"),
            ("jobs", "⚙  Jobs"),
            ("history", "🎬  History"),
            ("runner", "▶  Workflow"),
            ("settings", "🔑  Settings"),
        ]
        for key, label in nav:
            btn = ctk.CTkButton(
                bar, text=label, anchor="w", height=44, corner_radius=10,
                fg_color="transparent", hover_color=COLORS["panel"],
                text_color=COLORS["muted"], font=(FONT, 14),
                command=lambda k=key: self.show_view(k))
            btn.pack(fill="x", padx=14, pady=4)
            self.nav_buttons[key] = btn

        foot = ctk.CTkFrame(bar, fg_color="transparent")
        foot.pack(side="bottom", fill="x", padx=14, pady=18)
        ctk.CTkButton(foot, text="↻ Refresh", height=36, corner_radius=9,
                      fg_color=COLORS["panel2"], hover_color=COLORS["border"],
                      command=self.refresh_data).pack(fill="x", pady=3)
        ctk.CTkButton(foot, text="✓ Preflight", height=36, corner_radius=9,
                      fg_color=COLORS["accent"], hover_color=COLORS["accent_hover"],
                      text_color="#000",
                      command=self._run_preflight).pack(fill="x", pady=3)
        self.clock_lbl = ctk.CTkLabel(foot, text="--:--", font=(FONT, 12),
                                      text_color=COLORS["muted"])
        self.clock_lbl.pack(pady=(10, 0))

    def _build_main(self):
        wrap = ctk.CTkFrame(self, fg_color="transparent")
        wrap.grid(row=0, column=1, sticky="nsew")
        wrap.grid_columnconfigure(0, weight=1)
        wrap.grid_rowconfigure(1, weight=1)

        header = ctk.CTkFrame(wrap, fg_color="transparent", height=64)
        header.grid(row=0, column=0, sticky="ew", padx=26, pady=(22, 8))
        self.view_title = ctk.CTkLabel(header, text="RINGKASAN", font=(FONT, 20, "bold"),
                                       text_color=COLORS["text"])
        self.view_title.pack(side="left")
        self.status_lbl = ctk.CTkLabel(header, text="Memuat...", font=(FONT, 12),
                                       text_color=COLORS["muted"])
        self.status_lbl.pack(side="right")

        self.content = ctk.CTkFrame(wrap, fg_color="transparent")
        self.content.grid(row=1, column=0, sticky="nsew", padx=26, pady=(0, 22))
        self.content.grid_columnconfigure(0, weight=1)
        self.content.grid_rowconfigure(0, weight=1)

        self.views = {}
        for key in ["dashboard", "queue", "jobs", "history", "runner", "settings"]:
            frame = ctk.CTkFrame(self.content, fg_color="transparent")
            frame.grid(row=0, column=0, sticky="nsew")
            frame.grid_columnconfigure(0, weight=1)
            frame.grid_rowconfigure(0, weight=1)
            self.views[key] = frame
            frame.grid_remove()

        self._build_dashboard(self.views["dashboard"])
        self._build_queue(self.views["queue"])
        self._build_jobs(self.views["jobs"])
        self._build_history(self.views["history"])
        self._build_runner(self.views["runner"])
        self._build_settings(self.views["settings"])

    def show_view(self, key):
        if self.current_view:
            self.views[self.current_view].grid_remove()
            self.nav_buttons[self.current_view].configure(fg_color="transparent",
                                                           text_color=COLORS["muted"])
        self.current_view = key
        self.views[key].grid()
        self.nav_buttons[key].configure(fg_color=COLORS["panel"],
                                         text_color=COLORS["text"])
        titles = {
            "dashboard": "RINGKASAN",
            "queue": "QUEUE VIDEO",
            "jobs": "JOBS",
            "history": "HISTORY PUBLISH",
            "runner": "WORKFLOW RUNNER",
            "settings": "SETTINGS .ENV",
        }
        self.view_title.configure(text=titles.get(key, key.upper()))
        if key in ("queue", "jobs", "history"):
            self.refresh_data()

    def refresh_data(self):
        def fetch():
            state = api_get("/api/state")
            self.after(0, lambda: self._update_data(state))
        threading.Thread(target=fetch, daemon=True).start()

    def _update_data(self, state):
        if "error" in state:
            self.status_lbl.configure(text=f"Error: {state['error']}")
            return
        self.state = state
        self.status_lbl.configure(text=f"Update: {datetime.now().strftime('%H:%M:%S')}")
        self._update_dashboard(state)
        self._update_queue(state.get("videos", []))
        self._update_jobs(state.get("jobs", []))
        self._update_history(state.get("history", []))

    # ---------------- Dashboard ----------------
    def _build_dashboard(self, parent):
        parent.grid_rowconfigure(1, weight=1)

        cards_frame = ctk.CTkFrame(parent, fg_color="transparent")
        cards_frame.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        for i in range(6):
            cards_frame.grid_columnconfigure(i, weight=1)

        self.stat_cards = {}
        labels = [
            ("Queue Aktif", "videos_queued"),
            ("Jobs Total", "jobs_total"),
            ("Published", "jobs_published"),
            ("Failed", "jobs_failed"),
            ("Ready", "jobs_ready"),
            ("Publish Hari Ini", "today_published"),
        ]
        for i, (label, key) in enumerate(labels):
            card = ctk.CTkFrame(cards_frame, fg_color=COLORS["panel"], corner_radius=14,
                                border_width=1, border_color=COLORS["border"])
            card.grid(row=0, column=i, sticky="nsew", padx=(0 if i == 0 else 8, 0))
            ctk.CTkLabel(card, text="0", font=(FONT, 28, "bold"),
                         text_color=COLORS["accent"]).pack(anchor="w", padx=16, pady=(14, 0))
            ctk.CTkLabel(card, text=label, font=(FONT, 12),
                         text_color=COLORS["muted"]).pack(anchor="w", padx=16, pady=(0, 14))
            self.stat_cards[key] = card.winfo_children()[0]

        bottom = ctk.CTkFrame(parent, fg_color="transparent")
        bottom.grid(row=1, column=0, sticky="nsew")
        bottom.grid_columnconfigure(0, weight=1)
        bottom.grid_columnconfigure(1, weight=1)
        bottom.grid_rowconfigure(0, weight=1)

        # Trend chart
        trend_card = ctk.CTkFrame(bottom, fg_color=COLORS["panel"], corner_radius=14,
                                  border_width=1, border_color=COLORS["border"])
        trend_card.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        trend_card.grid_columnconfigure(0, weight=1)
        trend_card.grid_rowconfigure(1, weight=1)
        ctk.CTkLabel(trend_card, text="Trend 7 Hari", font=(FONT, 14, "bold"),
                     text_color=COLORS["text"]).grid(row=0, column=0, sticky="w", padx=16, pady=14)
        self.trend_canvas = ctk.CTkCanvas(trend_card, bg=COLORS["panel"], highlightthickness=0,
                                          height=220)
        self.trend_canvas.grid(row=1, column=0, sticky="nsew", padx=16, pady=(0, 16))

        # System status
        status_card = ctk.CTkFrame(bottom, fg_color=COLORS["panel"], corner_radius=14,
                                   border_width=1, border_color=COLORS["border"])
        status_card.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        status_card.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(status_card, text="Status Sistem", font=(FONT, 14, "bold"),
                     text_color=COLORS["text"]).grid(row=0, column=0, sticky="w", padx=16, pady=14)
        self.status_list = ctk.CTkFrame(status_card, fg_color="transparent")
        self.status_list.grid(row=1, column=0, sticky="nsew", padx=16, pady=(0, 16))

    def _update_dashboard(self, state):
        stats = state.get("stats", {})
        for label, key in [
            ("Queue Aktif", "videos_queued"),
            ("Jobs Total", "jobs_total"),
            ("Published", "jobs_published"),
            ("Failed", "jobs_failed"),
            ("Ready", "jobs_ready"),
            ("Publish Hari Ini", "today_published"),
        ]:
            self.stat_cards[key].configure(text=str(stats.get(key, 0)))
        self._draw_trend(stats.get("series7", []))
        self._update_status_list(stats)

    def _draw_trend(self, series):
        c = self.trend_canvas
        c.delete("all")
        w = c.winfo_width() or 400
        h = c.winfo_height() or 220
        pad = 32
        if not series:
            return
        max_val = max(1, max(d.get("published", 0) for d in series))
        step = (w - pad * 2) / max(1, len(series) - 1)
        pts = []
        for i, d in enumerate(series):
            x = pad + i * step
            y = h - pad - (d.get("published", 0) / max_val) * (h - pad * 2)
            pts.append((x, y, d))
        if len(pts) > 1:
            coords = []
            for x, y, _ in pts:
                coords.extend([x, y])
            c.create_line(coords, fill=COLORS["accent"], width=3, smooth=False)
        for x, y, d in pts:
            c.create_oval(x - 4, y - 4, x + 4, y + 4, fill=COLORS["accent"], outline="")
            c.create_text(x, h - 12, text=d["date"][5:], fill=COLORS["muted"], font=(FONT, 9))

    def _update_status_list(self, stats):
        for w in self.status_list.winfo_children():
            w.destroy()
        items = [
            ("Mode", "LIVE" if not stats.get("dry_run") else "DRY RUN"),
            ("Auto Publish", "ON" if stats.get("auto_publish") else "OFF"),
            ("Upload Driver", stats.get("upload_driver", "local")),
            ("AI Provider", stats.get("ai_provider", "openai")),
            ("Timezone", stats.get("timezone", "-")),
            ("Total 7 Hari", str(stats.get("total7", 0))),
        ]
        for label, value in items:
            row = ctk.CTkFrame(self.status_list, fg_color="transparent")
            row.pack(fill="x", pady=4)
            ctk.CTkLabel(row, text=label, font=(FONT, 12),
                         text_color=COLORS["muted"]).pack(side="left")
            ctk.CTkLabel(row, text=value, font=(FONT, 12, "bold"),
                         text_color=COLORS["text"]).pack(side="right")

    # ---------------- Queue ----------------
    def _build_queue(self, parent):
        parent.grid_rowconfigure(1, weight=1)

        top = ctk.CTkFrame(parent, fg_color="transparent")
        top.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        top.grid_columnconfigure(0, weight=1)
        top.grid_columnconfigure(1, weight=1)

        form = ctk.CTkFrame(top, fg_color=COLORS["panel"], corner_radius=14,
                            border_width=1, border_color=COLORS["border"])
        form.grid(row=0, column=0, sticky="nsew", padx=(0, 8))
        ctk.CTkLabel(form, text="Tambah Video", font=(FONT, 14, "bold"),
                     text_color=COLORS["text"]).pack(anchor="w", padx=16, pady=14)

        self.q_url = ctk.CTkEntry(form, placeholder_text="https://www.youtube.com/watch?v=...")
        self.q_url.pack(fill="x", padx=16, pady=4)
        self.q_theme = ctk.CTkEntry(form, placeholder_text="Theme")
        self.q_theme.insert(0, "podcast artis")
        self.q_theme.pack(fill="x", padx=16, pady=4)
        ctk.CTkButton(form, text="Tambah ke Queue", fg_color=COLORS["accent"],
                      hover_color=COLORS["accent_hover"], text_color="#000",
                      command=self._add_video).pack(anchor="w", padx=16, pady=(8, 16))

        stats = ctk.CTkFrame(top, fg_color=COLORS["panel"], corner_radius=14,
                             border_width=1, border_color=COLORS["border"])
        stats.grid(row=0, column=1, sticky="nsew", padx=(8, 0))
        ctk.CTkLabel(stats, text="Statistik Queue", font=(FONT, 14, "bold"),
                     text_color=COLORS["text"]).pack(anchor="w", padx=16, pady=14)
        self.queue_stats = ctk.CTkLabel(stats, text="-", font=(FONT, 12),
                                        text_color=COLORS["muted"])
        self.queue_stats.pack(anchor="w", padx=16, pady=(0, 16))

        list_card = ctk.CTkFrame(parent, fg_color=COLORS["panel"], corner_radius=14,
                                 border_width=1, border_color=COLORS["border"])
        list_card.grid(row=1, column=0, sticky="nsew")
        list_card.grid_columnconfigure(0, weight=1)
        list_card.grid_rowconfigure(1, weight=1)
        ctk.CTkLabel(list_card, text="Daftar Queue", font=(FONT, 14, "bold"),
                     text_color=COLORS["text"]).grid(row=0, column=0, sticky="w", padx=16, pady=14)

        cols = [("url", "URL", 420), ("theme", "Theme", 120), ("target", "Target", 100), ("status", "Status", 100)]
        self.queue_tree = ttk.Treeview(list_card, columns=[c[0] for c in cols], show="headings", height=10)
        for key, text, width in cols:
            self.queue_tree.heading(key, text=text)
            self.queue_tree.column(key, width=width, anchor="w")
        self.queue_tree.grid(row=1, column=0, sticky="nsew", padx=16, pady=(0, 16))

        ctx = ctk.CTkFrame(list_card, fg_color="transparent")
        ctx.grid(row=2, column=0, sticky="ew", padx=16, pady=(0, 16))
        ctk.CTkButton(ctx, text="Set queued", width=90,
                      command=lambda: self._set_video_status("queued")).pack(side="left", padx=4)
        ctk.CTkButton(ctx, text="Set expired", width=90,
                      command=lambda: self._set_video_status("expired")).pack(side="left", padx=4)
        ctk.CTkButton(ctx, text="Hapus", width=90, fg_color=COLORS["err"],
                      hover_color="#dc2626",
                      command=self._delete_video).pack(side="left", padx=4)

    def _update_queue(self, videos):
        self.queue_tree.delete(*self.queue_tree.get_children())
        videos = sorted(videos, key=lambda v: parse_dt(v.get("created_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc), reverse=True)
        active = [v for v in videos if v.get("status") != "expired"]
        queued = [v for v in active if v.get("status", "queued") == "queued"]
        expired = [v for v in videos if v.get("status") == "expired"]
        self.queue_stats.configure(text=f"Total: {len(videos)} | Aktif: {len(active)} | "
                                        f"Queued: {len(queued)} | Expired: {len(expired)}")
        for v in videos:
            self.queue_tree.insert("", "end", iid=v.get("id"),
                                   values=(v.get("url", "")[:60], v.get("theme", "-"),
                                           v.get("target_date", "-"), v.get("status", "-")))

    def _selected_video_id(self):
        sel = self.queue_tree.selection()
        return sel[0] if sel else None

    def _add_video(self):
        url = self.q_url.get().strip()
        if not url:
            messagebox.showwarning("Input Kosong", "URL wajib diisi.")
            return
        data = {"url": url, "theme": self.q_theme.get().strip()}
        res = api_post("/api/videos", data)
        if "error" in res:
            messagebox.showerror("Gagal", res["error"])
        else:
            self.q_url.delete(0, "end")
            self.refresh_data()

    def _set_video_status(self, status):
        vid = self._selected_video_id()
        if not vid:
            return
        res = api_request(f"/api/videos/{vid}", {"status": status}, "PATCH")
        if "error" in res:
            messagebox.showerror("Gagal", res["error"])
        else:
            self.refresh_data()

    def _delete_video(self):
        vid = self._selected_video_id()
        if not vid:
            return
        if not messagebox.askyesno("Hapus", "Hapus video dari queue?"):
            return
        res = api_request(f"/api/videos/{vid}", None, "DELETE")
        if "error" in res:
            messagebox.showerror("Gagal", res["error"])
        else:
            self.refresh_data()

    # ---------------- Jobs ----------------
    def _build_jobs(self, parent):
        parent.grid_rowconfigure(1, weight=1)
        top = ctk.CTkFrame(parent, fg_color="transparent")
        top.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        self.job_search = ctk.CTkEntry(top, placeholder_text="Cari judul/url/job id...")
        self.job_search.pack(side="left", fill="x", expand=True, padx=(0, 8))
        self.job_status = ctk.CTkOptionMenu(top, values=["Semua", "published", "failed", "ready_to_publish", "queued"])
        self.job_status.set("Semua")
        self.job_status.pack(side="left", padx=8)
        ctk.CTkButton(top, text="Filter", command=self._load_jobs).pack(side="left", padx=8)

        list_card = ctk.CTkFrame(parent, fg_color=COLORS["panel"], corner_radius=14,
                                 border_width=1, border_color=COLORS["border"])
        list_card.grid(row=1, column=0, sticky="nsew")
        list_card.grid_columnconfigure(0, weight=1)
        list_card.grid_rowconfigure(0, weight=1)

        cols = [("job_id", "Job ID", 150), ("title", "Judul", 220), ("status", "Status", 100),
                ("clipper", "Clipper", 80), ("caption", "Caption", 80), ("thumbnail", "Thumbnail", 80), ("publish", "Publish", 100)]
        self.job_tree = ttk.Treeview(list_card, columns=[c[0] for c in cols], show="headings", height=16)
        for key, text, width in cols:
            self.job_tree.heading(key, text=text)
            self.job_tree.column(key, width=width, anchor="w")
        self.job_tree.grid(row=0, column=0, sticky="nsew", padx=16, pady=16)

        ctx = ctk.CTkFrame(list_card, fg_color="transparent")
        ctx.grid(row=1, column=0, sticky="ew", padx=16, pady=(0, 16))
        ctk.CTkButton(ctx, text="Retry", command=self._retry_job).pack(side="left", padx=4)
        ctk.CTkButton(ctx, text="Detail", command=self._detail_job).pack(side="left", padx=4)

    def _load_jobs(self):
        def fetch():
            params = {"q": self.job_search.get().strip()}
            status = self.job_status.get()
            if status != "Semua":
                params["status"] = status
            import urllib.parse
            qs = urllib.parse.urlencode(params)
            jobs = api_get(f"/api/jobs?{qs}")
            self.after(0, lambda: self._update_jobs_list(jobs))
        threading.Thread(target=fetch, daemon=True).start()

    def _update_jobs(self, jobs):
        self._update_jobs_list(jobs)

    def _update_jobs_list(self, jobs):
        if isinstance(jobs, dict) and "error" in jobs:
            return
        self.job_tree.delete(*self.job_tree.get_children())
        jobs = sorted(jobs, key=lambda j: parse_dt(j.get("updated_at") or j.get("created_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc), reverse=True)
        for j in jobs[:100]:
            title = (j.get("source_title") or "-")[:38]
            self.job_tree.insert("", "end", iid=j.get("job_id"),
                                 values=(j.get("job_id", ""), title,
                                         j.get("status", ""), j.get("clipper_status", ""),
                                         j.get("caption_status", ""), j.get("thumbnail_status", ""),
                                         j.get("publish_status", "")))

    def _selected_job_id(self):
        sel = self.job_tree.selection()
        return sel[0] if sel else None

    def _retry_job(self):
        jid = self._selected_job_id()
        if not jid:
            return
        res = api_post(f"/api/jobs/{jid}/retry")
        if "error" in res:
            messagebox.showerror("Gagal", res["error"])
        else:
            self._load_jobs()

    def _detail_job(self):
        jid = self._selected_job_id()
        if not jid:
            return
        job = next((j for j in self.state.get("jobs", []) if j.get("job_id") == jid), {})
        if not job:
            return
        win = ctk.CTkToplevel(self)
        win.title(f"Detail {jid}")
        win.geometry("800x600")
        win.configure(fg_color=COLORS["bg"])
        txt = ctk.CTkTextbox(win, fg_color=COLORS["panel2"], text_color=COLORS["text"],
                             font=("Consolas", 11))
        txt.pack(fill="both", expand=True, padx=16, pady=16)
        txt.insert("0.0", json.dumps(job, indent=2, ensure_ascii=False))
        txt.configure(state="disabled")

    # ---------------- History ----------------
    def _build_history(self, parent):
        parent.grid_rowconfigure(0, weight=1)
        list_card = ctk.CTkFrame(parent, fg_color=COLORS["panel"], corner_radius=14,
                                 border_width=1, border_color=COLORS["border"])
        list_card.grid(row=0, column=0, sticky="nsew")
        list_card.grid_columnconfigure(0, weight=1)
        list_card.grid_rowconfigure(0, weight=1)

        cols = [("date", "Tanggal", 90), ("caption", "Caption/Judul", 360), ("status", "Status", 90),
                ("youtube", "YT", 50), ("facebook", "FB", 50), ("instagram", "IG", 50), ("tiktok", "TT", 50), ("threads", "TH", 50)]
        self.history_tree = ttk.Treeview(list_card, columns=[c[0] for c in cols], show="headings", height=18)
        for key, text, width in cols:
            self.history_tree.heading(key, text=text)
            self.history_tree.column(key, width=width, anchor="center" if key not in ("date", "caption", "status") else "w")
        self.history_tree.grid(row=0, column=0, sticky="nsew", padx=16, pady=16)

    def _update_history(self, history):
        self.history_tree.delete(*self.history_tree.get_children())
        history = sorted(history, key=lambda h: parse_dt(h.get("published_at") or h.get("recorded_at") or h.get("publish_date")) or datetime(1970, 1, 1, tzinfo=timezone.utc), reverse=True)
        for idx, h in enumerate(history[:100]):
            caption = (h.get("caption") or h.get("job_id") or "-")[:55]
            self.history_tree.insert("", "end", iid=f"hist_{idx}_{h.get('job_id', '')}",
                values=(h.get("publish_date", "-"),
                        caption,
                        h.get("status", "-"),
                        "✓" if h.get("youtube_url") else "-",
                        "✓" if (h.get("facebook_video_id") or h.get("facebook_post_id") or h.get("facebook_url")) else "-",
                        "✓" if h.get("instagram_media_id") else "-",
                        "✓" if h.get("tiktok_publish_id") else "-",
                        "✓" if h.get("threads_media_id") else "-"))

    # ---------------- Runner ----------------
    def _build_runner(self, parent):
        parent.grid_rowconfigure(2, weight=1)

        form = ctk.CTkFrame(parent, fg_color=COLORS["panel"], corner_radius=14,
                            border_width=1, border_color=COLORS["border"])
        form.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        form.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(form, text="Workflow Generator → Upload",
                     font=(FONT, 14, "bold"), text_color=COLORS["text"]).grid(row=0, column=0, sticky="w", padx=16, pady=14)

        grid = ctk.CTkFrame(form, fg_color="transparent")
        grid.grid(row=1, column=0, sticky="ew", padx=16, pady=(0, 8))
        for i in range(4):
            grid.grid_columnconfigure(i, weight=1)

        self.w_url = self._entry(grid, 0, 0, "YouTube URL (kosong = queue)", wide=True, span=3)
        self.w_theme = self._entry(grid, 0, 3, "Theme", value="podcast artis")
        self.w_range = self._entry(grid, 1, 0, "Range (00:01:20-00:02:05)")
        self.w_quality = ctk.CTkOptionMenu(grid, values=["standard", "fast", "high", "ultra"])
        self.w_quality.set("standard")
        self.w_quality.grid(row=1, column=1, sticky="ew", padx=4, pady=4)
        self.w_clips = self._entry(grid, 1, 2, "Clip count", value="1")

        flags = ctk.CTkFrame(form, fg_color="transparent")
        flags.grid(row=2, column=0, sticky="w", padx=16, pady=8)
        self.w_frame = ctk.CTkCheckBox(flags, text="Frame", checkbox_width=18, checkbox_height=18)
        self.w_frame.select()
        self.w_frame.pack(side="left", padx=8)
        self.w_filter = ctk.CTkCheckBox(flags, text="Filter", checkbox_width=18, checkbox_height=18)
        self.w_filter.select()
        self.w_filter.pack(side="left", padx=8)
        self.w_sub = ctk.CTkCheckBox(flags, text="Subtitle + emoji", checkbox_width=18, checkbox_height=18)
        self.w_sub.select()
        self.w_sub.pack(side="left", padx=8)
        self.w_publish = ctk.CTkCheckBox(flags, text="Publish", checkbox_width=18, checkbox_height=18)
        self.w_publish.select()
        self.w_publish.pack(side="left", padx=8)
        self.w_dry = ctk.CTkCheckBox(flags, text="Dry-run", checkbox_width=18, checkbox_height=18)
        self.w_dry.pack(side="left", padx=8)

        ctk.CTkButton(form, text="Mulai Workflow", fg_color=COLORS["accent"],
                      hover_color=COLORS["accent_hover"], text_color="#000",
                      command=self._start_workflow).grid(row=3, column=0, sticky="w", padx=16, pady=(8, 16))

        console_card = ctk.CTkFrame(parent, fg_color=COLORS["panel"], corner_radius=14,
                                    border_width=1, border_color=COLORS["border"])
        console_card.grid(row=2, column=0, sticky="nsew")
        console_card.grid_columnconfigure(0, weight=1)
        console_card.grid_rowconfigure(1, weight=1)

        head = ctk.CTkFrame(console_card, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", padx=16, pady=14)
        ctk.CTkLabel(head, text="Live Console", font=(FONT, 14, "bold"),
                     text_color=COLORS["text"]).pack(side="left")
        self.console_cmd = ctk.CTkLabel(head, text="idle", font=(FONT, 11),
                                        text_color=COLORS["muted"])
        self.console_cmd.pack(side="right", padx=8)
        ctk.CTkButton(head, text="Stop", width=60, fg_color=COLORS["err"],
                      hover_color="#dc2626", command=self._stop_console).pack(side="right", padx=4)
        ctk.CTkButton(head, text="Clear", width=60, command=self._clear_console).pack(side="right", padx=4)

        self.console_txt = ctk.CTkTextbox(console_card, fg_color="#050608",
                                          text_color="#cbd5e1", font=("Consolas", 10))
        self.console_txt.grid(row=1, column=0, sticky="nsew", padx=16, pady=(0, 16))

    def _entry(self, parent, row, col, placeholder, value=None, wide=False, span=1):
        e = ctk.CTkEntry(parent, placeholder_text=placeholder)
        e.grid(row=row, column=col, columnspan=span, sticky="ew", padx=4, pady=4)
        if value:
            e.insert(0, value)
        return e

    def _start_workflow(self):
        data = {
            "url": self.w_url.get().strip(),
            "theme": self.w_theme.get().strip(),
            "range": self.w_range.get().strip(),
            "quality_profile": self.w_quality.get(),
            "clip_count": int(self.w_clips.get() or 1),
            "use_frame": bool(self.w_frame.get()),
            "use_filter": bool(self.w_filter.get()),
            "use_watermark": False,
            "use_subtitle_highlight": bool(self.w_sub.get()),
            "dry_run": bool(self.w_dry.get()),
            "publish": bool(self.w_publish.get()),
        }
        res = api_post("/api/run/workflow", data)
        if "error" in res:
            messagebox.showerror("Gagal", res["error"])
        else:
            self._start_console_poll("workflow")

    def _start_console_poll(self, cmd):
        self.console_cmd.configure(text=cmd)
        self.console_poll_cmd = cmd
        self._poll_console()

    def _poll_console(self):
        if not self.console_poll_cmd or not self.running:
            return
        cmd = self.console_poll_cmd

        def fetch():
            data = api_get(f"/api/run/{cmd}/status")
            self.after(0, lambda: self._update_console(data))
        threading.Thread(target=fetch, daemon=True).start()

    def _update_console(self, data):
        if "error" in data:
            return
        log = data.get("log", [])
        self.console_txt.configure(state="normal")
        self.console_txt.delete("0.0", "end")
        self.console_txt.insert("0.0", "\n".join(log))
        self.console_txt.see("end")
        self.console_txt.configure(state="disabled")
        if data.get("running"):
            self.console_poll_after = self.after(1000, self._poll_console)
        else:
            self.console_cmd.configure(text="idle")
            self.console_poll_cmd = None

    def _stop_console(self):
        if self.console_poll_cmd:
            api_post(f"/api/run/{self.console_poll_cmd}/stop")

    def _clear_console(self):
        self.console_txt.configure(state="normal")
        self.console_txt.delete("0.0", "end")
        self.console_txt.configure(state="disabled")

    def _run_preflight(self):
        self.show_view("runner")
        self.console_cmd.configure(text="preflight")
        self.console_txt.configure(state="normal")
        self.console_txt.insert("end", "Menjalankan preflight...\n")
        self.console_txt.configure(state="disabled")

        def fetch():
            data = api_post("/api/preflight")
            self.after(0, lambda: self._show_preflight_result(data))
        threading.Thread(target=fetch, daemon=True).start()

    def _show_preflight_result(self, data):
        self.console_txt.configure(state="normal")
        self.console_txt.delete("0.0", "end")
        if data.get("ok"):
            lines = data.get("stdout", []) + data.get("stderr", [])
            self.console_txt.insert("0.0", "\n".join(lines))
        else:
            self.console_txt.insert("0.0", f"Preflight gagal:\n{data.get('error', '-')}")
        self.console_txt.configure(state="disabled")
        self.console_cmd.configure(text="idle")

    # ---------------- Settings ----------------
    def _build_settings(self, parent):
        parent.grid_rowconfigure(1, weight=1)
        head = ctk.CTkFrame(parent, fg_color="transparent")
        head.grid(row=0, column=0, sticky="ew", pady=(0, 16))
        ctk.CTkButton(head, text="Simpan .env", fg_color=COLORS["accent"],
                      hover_color=COLORS["accent_hover"], text_color="#000",
                      command=self._save_env).pack(side="right")
        ctk.CTkLabel(head, text="Editor .env", font=(FONT, 14, "bold"),
                     text_color=COLORS["text"]).pack(side="left")

        self.env_text = ctk.CTkTextbox(parent, fg_color=COLORS["panel2"],
                                       text_color=COLORS["text"], font=("Consolas", 11))
        self.env_text.grid(row=1, column=0, sticky="nsew")
        self._load_env()

    def _load_env(self):
        if ENV_PATH.exists():
            self.env_text.delete("0.0", "end")
            self.env_text.insert("0.0", ENV_PATH.read_text(encoding="utf-8"))

    def _save_env(self):
        content = self.env_text.get("0.0", "end")
        try:
            ENV_PATH.write_text(content, encoding="utf-8")
            messagebox.showinfo("Tersimpan", ".env berhasil diperbarui.")
        except Exception as e:
            messagebox.showerror("Gagal", str(e))

    # ---------------- Misc ----------------
    def _poll_clock(self):
        self.clock_lbl.configure(text=datetime.now().strftime("%H:%M:%S"))
        self.after(1000, self._poll_clock)

    def _drain_log(self):
        try:
            while True:
                msg = self.log_queue.get_nowait()
                print(msg)
        except queue.Empty:
            pass
        self.after(100, self._drain_log)

    def on_closing(self):
        self.running = False
        if self.console_poll_after:
            self.after_cancel(self.console_poll_after)
        self.destroy()


def _log(msg):
    try:
        with open(APP_DIR / "app.log", "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat()} {msg}\n")
    except Exception:
        pass


def main():
    ctk.deactivate_automatic_dpi_awareness()
    ctk.set_widget_scaling(1.0)
    ctk.set_window_scaling(1.0)

    try:
        # Jika port sudah dipakai aplikasi lain, asumsikan server sudah jalan.
        if wait_for_server(timeout=3):
            _log("Server sudah berjalan, membuka window saja.")
        else:
            _log("Memulai server Flask...")
            server_thread = threading.Thread(target=start_server, daemon=True)
            server_thread.start()
            if not wait_for_server():
                raise RuntimeError("Server tidak bisa dimulai.")

        app = ClipperDesktopApp()
        app.protocol("WM_DELETE_WINDOW", app.on_closing)
        app.mainloop()
    except Exception as e:
        _log(f"ERROR: {e}")
        import traceback
        _log(traceback.format_exc())
        messagebox.showerror("Clipper Desktop Error", f"Aplikasi gagal dibuka:\n{e}\n\nDetail ada di app.log")
        raise


if __name__ == "__main__":
    main()
