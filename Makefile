.PHONY: test unit integration test-integration e2e test-e2e worker lint typecheck build test-crash

test: unit integration

unit:
	npm run test:unit

integration:
	npm run test:integration

test-integration: integration

e2e:
	npm run test:e2e

test-e2e: e2e

test-crash:
	npx tsx scripts/verify-worker-crash.ts

worker:
	npm run worker

lint:
	npm run lint

typecheck:
	npm run typecheck

build:
	npm run build
