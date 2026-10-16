.PHONY: test lint typecheck build

test:
	npm test -- --run

lint:
	npm run lint

typecheck:
	npm run typecheck

build:
	npm run build
