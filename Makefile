.PHONY: install frontend build contractor-test contractor-validate

install:
	cd frontend && npm install

frontend:
	cd frontend && npm run dev

build:
	cd frontend && npm run build

# 施工队伍资质链路：修复后可单独重跑校验，不必整轮构建
contractor-validate:
	cd frontend && npm run contractor:validate

contractor-test:
	cd frontend && npm test
