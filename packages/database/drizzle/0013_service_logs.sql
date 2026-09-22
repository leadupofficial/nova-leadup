-- NOVA — a durable, queryable log store.
--
-- ## Why this exists
--
-- `GET /control/logs` used to answer `available: false` with a precise explanation: the API wrote
-- structured pino JSON to stdout, nothing in the repository persisted or queried it, and a "search"
-- would have had to invent its results. The route even named the fix — *"wire a sink to the pino
-- stream and add a query route over it"* — and this is that sink, self-hosted rather than depending on
-- Loki or OpenSearch, because a single Postgres instance is already the deployment's durable store
-- and adding a second system to operate would be a larger decision than the problem needs.
--
-- ## What is stored, and what is deliberately not
--
-- **Only `warn` and above by default** (`LOG_SINK_LEVEL`). The `info` stream in this codebase
-- includes per-request lines; persisting all of them would be one insert per HTTP request on the same
-- database that serves them, and the table would grow faster than anything reads it. Errors and
-- warnings are what an operator troubleshoots with. The level is configurable, and the console states
-- which one is in force so an absent line is never read as "nothing was logged".
--
-- ## Redaction is upstream, and that is the point
--
-- The sink receives the **serialised JSON pino has already redacted** — `pino.multistream` hands each
-- stream the final line — so a token or password cannot reach this table by a path the application
-- redactor does not cover. The sink parses that line and stores fields; it never sees the original
-- object. A test asserts a redacted path lands as `[redacted]`, not as the value.
--
-- ## Growth is bounded three ways
--
--  * the level filter above;
--  * `LOG_RETENTION_DAYS` (default 7), enforced by a delete on the sink's own flush cycle, so
--    retention needs no second scheduler;
--  * the write path never blocks a request — the sink buffers and batches, and drops the **oldest**
--    entries when the buffer is full, recording the drop count in a row of its own so a gap is
--    visible rather than silent.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "service_logs" (
	"id" bigserial PRIMARY KEY,
	"occurred_at" timestamp NOT NULL,
	-- 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
	"level" varchar(10) NOT NULL,
	-- The pino `base.service` field, so one table can hold more than one process later.
	"service" varchar(50) NOT NULL DEFAULT 'nova-api',
	"msg" text,
	"request_id" varchar(100),
	"user_id" varchar(100),
	"route" varchar(200),
	"method" varchar(10),
	"status_code" integer,
	"duration_ms" integer,
	"error_type" varchar(200),
	"error_message" text,
	-- Kept as text rather than jsonb-only: a stack trace read by a human is the whole point, and the
	-- console shows it verbatim.
	"stack" text,
	-- Everything else the call site logged, after pino's redaction. jsonb so it can be filtered on.
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL
);--> statement-breakpoint

-- The console's default view is "most recent first", so that is the index.
CREATE INDEX IF NOT EXISTS "service_logs_occurred_idx" ON "service_logs" USING btree ("occurred_at" DESC);--> statement-breakpoint
-- The error centre filters by level within a window.
CREATE INDEX IF NOT EXISTS "service_logs_level_occurred_idx" ON "service_logs" USING btree ("level", "occurred_at" DESC);--> statement-breakpoint
-- Correlation: `GET /control/traces/:traceId` and the per-log line "show me everything for this request".
CREATE INDEX IF NOT EXISTS "service_logs_request_idx" ON "service_logs" USING btree ("request_id") WHERE "request_id" IS NOT NULL;--> statement-breakpoint
-- "What happened to this user" — the same question the user detail page asks.
CREATE INDEX IF NOT EXISTS "service_logs_user_idx" ON "service_logs" USING btree ("user_id", "occurred_at" DESC) WHERE "user_id" IS NOT NULL;
