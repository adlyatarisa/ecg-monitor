# ECG & PCG Monitor System


## Prasyarat Sistem

Sebelum memulai, pastikan perangkatmu sudah menginstal perangkat lunak berikut:
1. **Docker Desktop**.
2. **Python 3.10+**.

---

## Cara Menjalankan Aplikasi


### Mode 1: Simulasi Data Historikal (Tanpa Hardware)

1. Buka terminal di folder root project.
2. Jalankan perintah Docker Compose:
   ```bash
   docker compose up --build -d
   ```
3. Tunggu hingga proses build selesai dan container berjalan (status *Healthy*).
4. Buka browser dan akses web: **http://localhost:3000**
5. Selesai! Web akan otomatis menerima stream data historikal.

> Untuk mematikan server, jalankan perintah `docker compose down`.

---

### Mode 2: Real-time dengan Hardware STM32

1. **Hubungkan STM32** ke port USB komputer/laptop.

2. **Jalankan Backend STM32:**
   - Buka File Explorer di folder root project ini, lalu **double-click (klik ganda) file `run-stm32.bat`**.
3. Buka web monitor di browser: **http://localhost:3000**
4. Di antarmuka (UI) web, lihat menu dropdown pengaturan. **Pilih Port** sesuai dengan perangkat STM32 kamu (contoh: `COM3`, `COM4`, atau `/dev/ttyUSB0`), pastikan baud rate `115200`, dan klik **Connect**.

---

## Struktur Project Utama

- `frontend/` — Aplikasi web User Interface berbasis Next.js, React, Tailwind CSS, dan Chart.js.
- `backend/` — Server Python untuk Filter DSP, Kalman Filter, Serial parsing, dan stream WebSocket.
  - `server.py` — Engine streaming data `.dat` statis (Berjalan otomatis di Docker).
  - `stm32_server.py` — Engine jembatan Serial-to-WebSocket untuk sensor fisik STM32.
- `data/` — Direktori tempat menyimpan file mentah `.dat`.
- `docker-compose.yml` — Orkestrator utama untuk container Frontend dan Backend historikal.             