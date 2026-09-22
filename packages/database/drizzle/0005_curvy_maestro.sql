ALTER TABLE "reminders" ADD COLUMN "dedupe_key" varchar(64);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "dedupe_key" varchar(64);--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_dedupe_key_idx" ON "reminders" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_dedupe_key_idx" ON "tasks" USING btree ("dedupe_key");--> statement-breakpoint
--
-- Create idempotency (P0-5 — "No idempotency on create").
--
-- `dedupe_key` is the identity of one create request. The API hashes
-- (user, normalised title, trigger instant, current 60-second window) — or, when
-- the caller sends an idempotency key, (user, that key). The unique indexes
-- above then decide the winner, so five concurrent identical POSTs are one row
-- and the four losers return the winner's row instead of a duplicate.
--
-- The trigger at the bottom is what protects the writers that do not compute a
-- key of their own: the assistant's `create_reminder` / `create_task` insert
-- with `dedupe_key` NULL (services/api/src/services/assistant-tool-executor.ts).
-- It fills the column in and *skips* the insert when the same content was
-- already filed inside the window. Skipping is `RETURN NULL` deliberately: the
-- caller's `INSERT ... RETURNING` then yields zero rows rather than raising
-- 23505, and the reminder the user asked for does exist — it is the one this
-- trigger just found. Without it a second identical voice ask would either
-- create a second reminder (the defect) or, with the index alone, report a
-- failure for a write that actually succeeded.
--
-- Two windows, on purpose:
--   * the key equality check is exact and unbounded, because the bucket inside
--     a content key bounds it already and an idempotency key is meant to be
--     honoured for as long as the row lives;
--   * the content check is a rolling 60 seconds and is what catches a row
--     written by the other formula (the trigger's key is not byte-identical to
--     the API's — it cannot be, since the API hashes a JS epoch while the
--     database only sees a `timestamp without time zone`).
--
CREATE OR REPLACE FUNCTION nova_normalise_title(value text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
	SELECT lower(btrim(regexp_replace(coalesce(value, ''), '\s+', ' ', 'g')));
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION nova_window_bucket()
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
	SELECT floor(extract(epoch FROM now()) / 60)::bigint;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION nova_task_dedupe_key(user_id uuid, title text, bucket bigint)
RETURNS varchar
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
	SELECT md5(
		coalesce(user_id::text, '') || '|' ||
		nova_normalise_title(title) || '|' ||
		coalesce(bucket::text, '')
	);
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION nova_reminder_dedupe_key(user_id uuid, title text, trigger_at timestamp, bucket bigint)
RETURNS varchar
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
	SELECT md5(
		coalesce(user_id::text, '') || '|' ||
		nova_normalise_title(title) || '|' ||
		coalesce(to_char(trigger_at, 'YYYY-MM-DD"T"HH24:MI:SS.US'), '') || '|' ||
		coalesce(bucket::text, '')
	);
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION nova_dedupe_reminder_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.dedupe_key IS NULL THEN
		NEW.dedupe_key := nova_reminder_dedupe_key(
			NEW.user_id, NEW.title, NEW.trigger_at, nova_window_bucket()
		);
	END IF;

	IF EXISTS (SELECT 1 FROM reminders r WHERE r.dedupe_key = NEW.dedupe_key) THEN
		RETURN NULL;
	END IF;

	IF EXISTS (
		SELECT 1 FROM reminders r
		WHERE r.user_id = NEW.user_id
			AND r.trigger_at = NEW.trigger_at
			AND r.created_at > now() - interval '60 seconds'
			AND nova_normalise_title(r.title) = nova_normalise_title(NEW.title)
	) THEN
		RETURN NULL;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION nova_dedupe_task_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF NEW.dedupe_key IS NULL THEN
		NEW.dedupe_key := nova_task_dedupe_key(NEW.user_id, NEW.title, nova_window_bucket());
	END IF;

	IF EXISTS (SELECT 1 FROM tasks t WHERE t.dedupe_key = NEW.dedupe_key) THEN
		RETURN NULL;
	END IF;

	IF EXISTS (
		SELECT 1 FROM tasks t
		WHERE t.user_id = NEW.user_id
			AND t.created_at > now() - interval '60 seconds'
			AND nova_normalise_title(t.title) = nova_normalise_title(NEW.title)
	) THEN
		RETURN NULL;
	END IF;

	RETURN NEW;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS reminders_dedupe_insert ON "reminders";--> statement-breakpoint
CREATE TRIGGER reminders_dedupe_insert
BEFORE INSERT ON "reminders"
FOR EACH ROW
EXECUTE FUNCTION nova_dedupe_reminder_insert();--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_dedupe_insert ON "tasks";--> statement-breakpoint
CREATE TRIGGER tasks_dedupe_insert
BEFORE INSERT ON "tasks"
FOR EACH ROW
EXECUTE FUNCTION nova_dedupe_task_insert();
