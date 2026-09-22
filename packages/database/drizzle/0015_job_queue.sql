-- NOVA — the job queue that `job_executions` was always shaped for.
--
-- ## Why this reuses an existing table
--
-- `job_executions` already carried `job_name`, `queue_name`, `worker_id`, `status`, `attempt`,
-- `max_attempts`, `payload`, `result`, `error_message`, `duration_ms`, `started_at` and `finished_at`.
-- The console's Jobs page reads it, and the retry action refused with 501 *because nothing enqueues* —
-- the table was a record shaped exactly like a queue with no producer. Adding a second table would have
-- meant two job concepts and a join between them, so this adds the two columns a queue needs and leaves
-- the shape alone.
--
-- ## What was missing
--
--  * **`run_at`** — when a row becomes claimable. Without it there is no way to express a retry backoff
--    or a scheduled job, which is why the in-process engines had to be timers.
--  * **`enqueued_by`** — who put it there. A retry triggered by an operator from the console is a
--    privileged action and has to be attributable after the fact.
--
-- ## The claim, and why it needs an index
--
-- A worker claims one row with `FOR UPDATE SKIP LOCKED`, ordered by `run_at`. That query's predicate is
-- `(status, run_at)`, so it gets an index: without one, every poll is a sequential scan over the whole
-- job history — and this table now grows with every provider check.
--
-- ## `worker_id` is also the lease
--
-- A worker that dies mid-job leaves a row in `running` for ever unless something reclaims it. Rather
-- than a second column, a running row whose `started_at` is older than the lease is treated as
-- abandoned and returned to `queued` by `reclaimStale()`. `worker_id` says who had it, which is what an
-- operator needs to see; `started_at` says whether to believe them.
--
-- Idempotent.

ALTER TABLE "job_executions"
	ADD COLUMN IF NOT EXISTS "run_at" timestamp NOT NULL DEFAULT now();--> statement-breakpoint

ALTER TABLE "job_executions"
	ADD COLUMN IF NOT EXISTS "enqueued_by" varchar(100);--> statement-breakpoint

-- The claim predicate.
CREATE INDEX IF NOT EXISTS "job_executions_claim_idx"
	ON "job_executions" USING btree ("status", "run_at");--> statement-breakpoint

-- The stale-lease sweep.
CREATE INDEX IF NOT EXISTS "job_executions_running_idx"
	ON "job_executions" USING btree ("status", "started_at") WHERE "status" = 'running';
