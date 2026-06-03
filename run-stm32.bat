@echo off
echo Menginstal dependensi...
cd backend
pip install -r requirements.txt
echo.
echo Menjalankan STM32 Server...
python stm32_server.py
pause
