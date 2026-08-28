# =========================================
# NOVA Development Makefile
# =========================================

.PHONY: help install dev dev-api dev-workers build lint type-check test clean docker-up docker-down docker-reset docker-prod-up docker-prod-down backup-db restore-db

help: ## Show this help message
 @echo 'Usage: make [target]'
 @echo ''
 @echo 'Available targets:'
 @awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf " %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install all dependencies
 pnpm install --frozen-lockfile

dev: ## Start all services in development mode
 pnpm run dev

dev-api: ## Start only the API service
 pnpm run dev -- --filter=@nova/api

dev-workers: ## Start only the workers service
 pnpm run dev -- --filter=@nova/workers

dev-admin: ## Start the admin service
 pnpm run dev -- --filter=@nova/admin

build: ## Build all packages and services
 pnpm run build

lint: ## Lint all packages and services
 pnpm run lint

type-check: ## Run TypeScript type checking
 pnpm run type-check

test: ## Run all tests
 pnpm run test

db:migrate: ## Run database migrations
 pnpm run db:migrate

db:seed: ## Seed the database
 pnpm run db:seed

clean: ## Clean all build artifacts
 pnpm run clean

docker-up: ## Start local dev stack (PostgreSQL, Redis, MinIO)
 docker compose up -d

docker-down: ## Stop local dev stack
 docker compose down

docker-reset: ## Reset local dev stack (removes volumes)
 docker compose down -v

docker-logs: ## Tail all service logs
 docker compose logs -f

docker-ps: ## Show running containers
 docker compose ps

docker-prod-up: ## Start production stack
 docker compose -f docker-compose.prod.yml up -d

docker-prod-down: ## Stop production stack
 docker compose -f docker-compose.prod.yml down

backup-db: ## Run database backup
 bash scripts/backup-db.sh

restore-db: ## Restore database from backup (ARG=path)
ifndef ARG
	@echo "Usage: make restore-db ARG=path/to/backup.sql.gz"
	@exit 1
endif
	bash scripts/restore-db.sh $(ARG)
