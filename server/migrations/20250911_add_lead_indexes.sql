-- ============================================================
-- NOVA-Leadup — Database indexes for lead query performance
-- ============================================================
--
-- Applied to the `leads` table.
--
-- Index strategy
-- ─────────────
-- 1. email — exact-match lookups (duplicate detection, auth)
-- 2. phone — exact-match lookups (duplicate detection)
-- 3. status — status-based filtering (lead lists, pipelines)
-- 4. created_at — range queries for recent leads, analytics
-- 5. composite (status, created_at) — common pipeline queries
-- 6. composite (email, phone) — duplicate-check safeguard
--
-- Note: partial unique indexes would enforce business rules at
-- the DB level (e.g. UNIQUE (email) WHERE deleted_at IS NULL).
-- Add them once your migration framework supports partial indexes.

-- ─── 1. E-mail (exact + prefix) ─────────────────────────────────────────
-- Exact-match is the primary duplicate-detection path.

CREATE INDEX IF NOT EXISTS idx_leads_email
 ON leads (email);

-- ─── 2. Phone (exact) ────────────────────────────────────────────────────
-- Normalised E.164 values; used for phone-based duplicate detection.

CREATE INDEX IF NOT EXISTS idx_leads_phone
 ON leads (phone)
 WHERE phone IS NOT NULL;

-- ─── 3. Status (enum filter) ────────────────────────────────────────────
-- Supports filtering by pipeline stage.

CREATE INDEX IF NOT EXISTS idx_leads_status
 ON leads (status);

-- ─── 4. Created-at (range) ───────────────────────────────────────────────
-- Supports "recent leads" queries and date-range analytics.

CREATE INDEX IF NOT EXISTS idx_leads_created_at
 ON leads (created_at DESC);

-- ─── 5. Composite: status + created_at ───────────────────────────────────
-- Covers the very common "show me all new leads, most recent first"
-- query pattern in one index.

CREATE INDEX IF NOT EXISTS idx_leads_status_created_at
 ON leads (status, created_at DESC);

-- ─── 6. Composite: email + phone ─────────────────────────────────────────
-- Guards against a lead that has the same e-mail *or* same phone as
-- another row. The DB can use this for the duplicate-check query
-- without two separate index lookups.

CREATE INDEX IF NOT EXISTS idx_leads_email_phone
 ON leads (email, phone);

-- ─── 7. Optional: full-text search on name + company ─────────────────────
-- Uncomment if your migration tool supports GIN indexes and your
-- application uses the `to_tsvector` search queries.

-- CREATE INDEX IF NOT EXISTS idx_leads_search_vector
-- ON leads USING GIN (
-- to_tsvector('english',
-- COALESCE(first_name, '') || ' ' ||
-- COALESCE(last_name, '') || ' ' ||
-- COALESCE(company, '')
-- )
-- );
