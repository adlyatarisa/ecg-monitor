.PHONY: run-stm32 setup-stm32

setup-stm32:
	cd backend && pip install -r requirements.txt

run-stm32: setup-stm32
	cd backend && python stm32_server.py
