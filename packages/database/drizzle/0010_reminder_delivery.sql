-- NOVA — reminder delivery instrumentation.
--
-- `reminders.triggered_at` has existed since the reminders table was first written and
-- **no code has ever set it**. Two things were therefore impossible:
--
--   * the console's "reminders executed" figure could not be computed, so it reported
--     NOT AVAILABLE while claiming the column would fix it; and
--   * the reminder revision history had no "fired" step, so a reminder the user saw and a
--     reminder that quietly came due were the same row.
--
-- The writer is `POST /api/v1/reminders/:id/acknowledge` (services/api/src/routes/
-- reminders.ts), called by the app when the user opens the reminder's notification —
-- see apps/mobile/lib/features/reminders/reminder_notifications.dart. It sets
-- `triggered_at` only when the column is still NULL, so a second acknowledgement is a
-- no-op rather than a new timestamp.
--
-- ## Why this is a trigger and not application code
--
-- The `trigger_at` journal in 0004 established the pattern: a trigger keeps the journal
-- correct for *every* writer of the column, not just the one that exists today. 0004 also
-- says, in as many words, "Do NOT also INSERT into `reminder_events` from application
-- code: that would double-count". The same rule applies here — the acknowledge route must
-- not insert a journal row itself.
--
-- ## Why the WHEN clause differs from 0004's
--
-- 0004 journals every distinct change of `trigger_at`, because a reminder can legitimately
-- be postponed many times. "This reminder fired" happens once, so this trigger fires only
-- on the NULL → non-NULL transition. Under the plain `IS DISTINCT FROM` form, a
-- re-acknowledgement that moved the timestamp would append a second "fired" row and the
-- engine's per-reminder history would read as two deliveries.
--
-- ## Idempotent
--
-- `CREATE OR REPLACE FUNCTION` plus `DROP TRIGGER IF EXISTS` means re-running this file
-- against a database that already has it is a no-op. Migrations before 0006 were not all
-- written that way and one of them had to be repaired by hand; this one is, because the
-- cost is two lines.
--
-- There is no backfill. Nothing recorded delivery before now, so every existing row's
-- `triggered_at` stays NULL — which the console reports as "no recorded delivery" rather
-- than as zero deliveries.

CREATE OR REPLACE FUNCTION nova_record_reminder_triggered()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	INSERT INTO reminder_events (reminder_id, user_id, event, from_trigger_at, to_trigger_at)
	VALUES (NEW.id, NEW.user_id, 'triggered', NULL, NEW.trigger_at);
	RETURN NULL;
END;
$$;--> statement-breakpoint
DROP TRIGGER IF EXISTS reminders_triggered_change ON "reminders";--> statement-breakpoint
CREATE TRIGGER reminders_triggered_change
AFTER UPDATE OF triggered_at ON "reminders"
FOR EACH ROW
WHEN (OLD.triggered_at IS NULL AND NEW.triggered_at IS NOT NULL)
EXECUTE FUNCTION nova_record_reminder_triggered();
