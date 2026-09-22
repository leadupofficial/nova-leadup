-- pgvector (`vector`) and `pg_trgm` must exist before the `vector(1536)` column
-- and the `gin_trgm_ops` index below can be created. Both statements are
-- idempotent and are no-ops where the extension is already installed.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reminder_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"event" varchar(50) NOT NULL,
	"from_trigger_at" timestamp,
	"to_trigger_at" timestamp,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "audio_recordings" ADD COLUMN IF NOT EXISTS "failure_reason" text;--> statement-breakpoint
ALTER TABLE "memory_embeddings" ADD COLUMN IF NOT EXISTS "embedding_vec" vector(1536);--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reminder_events" ADD CONSTRAINT "reminder_events_reminder_id_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."reminders"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "reminder_events" ADD CONSTRAINT "reminder_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reminder_events_reminder_occurred_idx" ON "reminder_events" USING btree ("reminder_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memories_content_trgm_idx" ON "memories" USING gin ("content" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memory_embeddings_embedding_hnsw_idx" ON "memory_embeddings" USING hnsw ("embedding_vec" vector_cosine_ops) WITH (m=16,ef_construction=64);--> statement-breakpoint
--
-- Reminder postponement journal.
--
-- Every writer that moves `reminders.trigger_at` is a plain single-row UPDATE
-- (`PATCH /reminders/:id` in services/api/src/routes/reminders.ts and the
-- assistant's `update_reminder` via changeReminder() in
-- services/api/src/services/assistant-tool-executor.ts), so a row trigger
-- captures both with no service change. `UPDATE OF trigger_at` fires only when
-- the column is in the SET list; the `WHEN` clause drops no-op writes where the
-- value is unchanged.
--
-- This is the mechanism that makes the journal self-populating. Do NOT also
-- INSERT into `reminder_events` from application code: that would double-count
-- every postponement.
CREATE OR REPLACE FUNCTION nova_record_reminder_trigger_at_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO reminder_events (reminder_id, user_id, event, from_trigger_at, to_trigger_at)
	VALUES (
		NEW.id,
		NEW.user_id,
		CASE WHEN NEW.trigger_at > OLD.trigger_at THEN 'postponed' ELSE 'rescheduled_earlier' END,
		OLD.trigger_at,
		NEW.trigger_at
	);
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS reminders_trigger_at_change ON "reminders";--> statement-breakpoint
CREATE TRIGGER reminders_trigger_at_change
AFTER UPDATE OF trigger_at ON "reminders"
FOR EACH ROW
WHEN (OLD.trigger_at IS DISTINCT FROM NEW.trigger_at)
EXECUTE FUNCTION nova_record_reminder_trigger_at_change();
