-- Admin Control Center — constraints and enforcement objects.
--
-- This file is a verbatim copy of the objects created at the end of
-- `0006_admin_control_center.sql`, extracted so they can be re-applied
-- idempotently. `scripts/repair-admin-migration.ts` runs it; the migration itself
-- inlines the same statements because drizzle applies a migration exactly once and
-- does not need the guards there.
--
-- Everything is guarded, so running this on an already-correct database is a no-op.

-- ─── Foreign keys ────────────────────────────────────────────────────────────
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'admin_sessions_user_id_users_id_fk'
	) THEN
		ALTER TABLE "admin_sessions"
			ADD CONSTRAINT "admin_sessions_user_id_users_id_fk"
			FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'job_executions_user_id_users_id_fk'
	) THEN
		ALTER TABLE "job_executions"
			ADD CONSTRAINT "job_executions_user_id_users_id_fk"
			FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;

	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint WHERE conname = 'job_executions_organization_id_organizations_id_fk'
	) THEN
		ALTER TABLE "job_executions"
			ADD CONSTRAINT "job_executions_organization_id_organizations_id_fk"
			FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END;
$$;

-- ─── Append-only enforcement for the admin audit log ─────────────────────────

CREATE OR REPLACE FUNCTION admin_audit_logs_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'admin_audit_logs is append-only: % is not permitted (attempted on id %)',
		TG_OP, COALESCE(OLD.id::text, 'unknown')
		USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS admin_audit_logs_no_update ON admin_audit_logs;
CREATE TRIGGER admin_audit_logs_no_update
	BEFORE UPDATE ON admin_audit_logs
	FOR EACH ROW EXECUTE FUNCTION admin_audit_logs_reject_mutation();

DROP TRIGGER IF EXISTS admin_audit_logs_no_delete ON admin_audit_logs;
CREATE TRIGGER admin_audit_logs_no_delete
	BEFORE DELETE ON admin_audit_logs
	FOR EACH ROW EXECUTE FUNCTION admin_audit_logs_reject_mutation();

-- ─── Value-shape guards ──────────────────────────────────────────────────────

DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_configs_scope_check') THEN
		ALTER TABLE "system_configs" ADD CONSTRAINT "system_configs_scope_check"
			CHECK ("scope" IN ('public', 'private', 'secret'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_configs_source_check') THEN
		ALTER TABLE "system_configs" ADD CONSTRAINT "system_configs_source_check"
			CHECK ("source" IN ('env', 'database'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'system_configs_secret_shape_check') THEN
		ALTER TABLE "system_configs" ADD CONSTRAINT "system_configs_secret_shape_check"
			CHECK (("scope" = 'secret' AND "value" IS NULL) OR ("scope" <> 'secret'));
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_flag_overrides_scope_check') THEN
		ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_scope_check"
			CHECK ("scope_type" IN ('environment', 'user', 'organization'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'feature_flag_overrides_percent_check') THEN
		ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_percent_check"
			CHECK ("rollout_percent" IS NULL OR ("rollout_percent" >= 0 AND "rollout_percent" <= 100));
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_audit_outcome_check') THEN
		ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_outcome_check"
			CHECK ("outcome" IN ('success', 'failure', 'denied'));
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'provider_health_status_check') THEN
		ALTER TABLE "provider_health_checks" ADD CONSTRAINT "provider_health_status_check"
			CHECK ("status" IN ('pass', 'fail', 'degraded', 'not_configured'));
	END IF;

	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_executions_status_check') THEN
		ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_status_check"
			CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'));
	END IF;
END;
$$;
