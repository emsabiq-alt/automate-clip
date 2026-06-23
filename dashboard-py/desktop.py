#!/usr/bin/env python3
"""
Aplikasi desktop untuk Clipper Dashboard.
Menjalankan Flask server di background lalu membuka jendela native
menggunakan pywebview sehingga terasa seperti aplikasi desktop.
"""

import sys
import threading
import time
import urllib.request

# Pastikan app.py bisa di-import dari folder yang sama
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))

from app import app, NPM_CMD  # noqa: E402

HOST = "127.0.0.1"
PORT = 8788
URL = f"http://{HOST}:{PORT}"


def start_server():
    """Jalankan Flask server di thread daemon."""
    app.run(host=HOST, port=PORT, debug=False, use_reloader=False)


def wait_for_server(timeout=30):
    """Tunggu sampai server siap menerima koneksi."""
    start = time.time()
    while time.time() - start < timeout:
        try:
            with urllib.request.urlopen(URL, timeout=1):
                return True
        except Exception:
            time.sleep(0.3)
    return False


def main():
    import webview

    print(f"[desktop] Memulai server di {URL} ...")
    server_thread = threading.Thread(target=start_server, daemon=True)
    server_thread.start()

    if not wait_for_server():
        print("[desktop] Server tidak bisa dimulai.")
        sys.exit(1)

    print("[desktop] Server siap. Membuka jendela desktop...")
    webview.create_window(
        title="Clipper Dashboard",
        url=URL,
        width=1500,
        height=900,
        min_size=(1024, 640),
        text_select=True,
    )
    webview.start()
    print("[desktop] Jendela ditutup.")


if __name__ == "__main__":
    main()
