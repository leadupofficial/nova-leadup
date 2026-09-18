-- NOVA-Leadup Database Migration: 20260101000000_001_create_migrations_table
-- This file defines the UP and DOWN migration for the migrations tracking table.
-- Run via: npm run db:migrate (up) or npm run db:rollback (down)

-- ============================================================
-- UP MIGRATION
-- ============================================================

-- Create migrations tracking table (idempotent)
CREATE TABLE IF NOT EXISTS migrations (
 id SERIAL PRIMARY KEY,
 name VARCHAR(255) NOT NULL UNIQUE,
 timestamp BIGINT NOT NULL,
 applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create index on name for fast lookup
CREATE INDEX IF NOT EXISTS idx_migrations_name ON migrations(name);

-- ============================================================
-- DOWN MIGRATION
-- ============================================================

-- Drop the migrations table
DROP TABLE IF EXISTS migrations;
