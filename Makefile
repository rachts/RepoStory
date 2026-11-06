.PHONY: test unit integration e2e test-e2e worker lint typecheck build

test: unit integration

unit:
	npm run test:unit

integration:
	npm run test:integration

e2e:
	npm run test:e2e

test-e2e: e2e

worker:
	npm run worker

lint:
	npm run lint

typecheck:
	npm run typecheck

build:
	npm run build
