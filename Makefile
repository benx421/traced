.PHONY: up down logs build emit

up:
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f nginx

build:
	docker compose build emitter

emit:
	docker compose --profile tools run --rm emitter
