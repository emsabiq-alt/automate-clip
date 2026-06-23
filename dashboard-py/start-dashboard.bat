@echo off
cd /d "C:\xampp\htdocs\oto\dashboard-py"
echo Menjalankan Clipper Desktop...
echo Jika jendela tidak muncul, cek file app.log di folder ini.
venv\Scripts\python.exe clipper_desktop.py
if %errorlevel% neq 0 (
  echo.
  echo Aplikasi keluar dengan error. Tekan tombol untuk melihat log.
  type app.log 2>nul
  pause
)
