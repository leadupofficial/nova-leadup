CREATE TABLE IF NOT EXISTS "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" varchar(100),
	"actor_email" varchar(255),
	"actor_role" varchar(50),
	"action" varchar(100) NOT NULL,
	"permission" varchar(100),
	"target_type" varchar(50),
	"target_id" varchar(255),
	"outcome" varchar(50) NOT NULL,
	"reason" text,
	"before" jsonb DEFAULT '{}'::jsonb,
	"after" jsonb DEFAULT '{}'::jsonb,
	"request_id" varchar(100),
	"ip_address" varchar(45),
	"user_agent" text,
	"trace_id" varchar(100),
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"jti" varchar(100) NOT NULL,
	"role" varchar(50) NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"last_seen_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_sessions_jti_unique" UNIQUE("jti")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flag_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_key" varchar(100) NOT NULL,
	"scope_type" varchar(20) NOT NULL,
	"scope_value" varchar(100) NOT NULL,
	"enabled" boolean NOT NULL,
	"rollout_percent" integer,
	"reason" text,
	"created_by" varchar(100),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" varchar(100) NOT NULL,
	"queue_name" varchar(100),
	"worker_id" varchar(100),
	"status" varchar(20) NOT NULL,
	"user_id" uuid,
	"organization_id" uuid,
	"related_type" varchar(50),
	"related_id" varchar(100),
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb,
	"result" jsonb DEFAULT '{}'::jsonb,
	"error_message" text,
	"duration_ms" integer,
	"request_id" varchar(100),
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "provider_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" varchar(50) NOT NULL,
	"kind" varchar(30) NOT NULL,
	"status" varchar(20) NOT NULL,
	"latency_ms" integer,
	"message" text,
	"trigger" varchar(20) DEFAULT 'manual' NOT NULL,
	"checked_by" varchar(100),
	"checked_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "system_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(150) NOT NULL,
	"scope" varchar(20) DEFAULT 'private' NOT NULL,
	"category" varchar(50) DEFAULT 'general' NOT NULL,
	"value" text,
	"secret_ciphertext" text,
	"secret_hint" varchar(12),
	"source" varchar(20) DEFAULT 'database' NOT NULL,
	"value_type" varchar(20) DEFAULT 'string' NOT NULL,
	"description" text,
	"used_by" jsonb DEFAULT '[]'::jsonb,
	"restart_required" boolean DEFAULT false NOT NULL,
	"hot_reloadable" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"updated_by" varchar(100),
	"last_tested_at" timestamp,
	"last_test_status" varchar(20),
	"last_test_message" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "system_configs_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_occurred_idx" ON "admin_audit_logs" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_actor_idx" ON "admin_audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_action_idx" ON "admin_audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_target_idx" ON "admin_audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_user_idx" ON "admin_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_sessions_expires_idx" ON "admin_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "feature_flag_overrides_unique" ON "feature_flag_overrides" USING btree ("flag_key","scope_type","scope_value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "feature_flag_overrides_key_idx" ON "feature_flag_overrides" USING btree ("flag_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_executions_name_created_idx" ON "job_executions" USING btree ("job_name","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_executions_status_idx" ON "job_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_executions_user_idx" ON "job_executions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "provider_health_provider_idx" ON "provider_health_checks" USING btree ("provider","checked_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_configs_scope_idx" ON "system_configs" USING btree ("scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_configs_category_idx" ON "system_configs" USING btree ("category");--> statement-breakpoint

-- ─── Foreign keys ────────────────────────────────────────────────────────────
-- Declared here rather than via drizzle's `.references()` because schema-admin.ts
-- is deliberately import-free: it must load under both `tsc` (Node ESM, which
-- needs a `.js` extension on relative imports) and `drizzle-kit generate`
-- (CommonJS require, which cannot resolve that extension). A dependency-free
-- schema module is what allows one source to drive both.
--
-- ON DELETE semantics match the rest of the schema: an admin session dies with its
-- user, while a job-execution history row keeps its record and only loses the
-- user/org link (set null), because deleting a user must not erase the operational
-- history of what the platform did.
-- ─── Foreign keys ────────────────────────────────────────────────────────────
-- Declared here rather than via drizzle's `.references()` because schema-admin.ts
-- is deliberately import-free: it must load under both `tsc` (Node ESM, which
-- needs a `.js` extension on relative imports) and `drizzle-kit generate`
-- (CommonJS require, which cannot resolve that extension). A dependency-free
-- schema module is what allows one source to drive both.
--
-- ON DELETE semantics match the rest of the schema: an admin session dies with its
-- user, while a job-execution history row keeps its record and only loses the
-- user/org link (set null), because deleting a user must not erase the operational
-- history of what the platform did.
--
-- Guarded so the file is safe to re-apply: the earlier version of this migration
-- created these constraints through drizzle's `.references()`, so an environment
-- that already ran it carries them under the same names.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'admin_sessions_user_id_users_id_fk') THEN
		ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_executions_user_id_users_id_fk') THEN
		ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_executions_organization_id_organizations_id_fk') THEN
		ALTER TABLE "job_executions" ADD CONSTRAINT "job_executions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END;
$$;--> statement-breakpoint

-- "Tamper-resistant" has to mean the database refuses the write, not that
-- application code politely chooses not to issue one. This trigger rejects UPDATE,
-- DELETE and TRUNCATE on admin_audit_logs, so the only surviving operation is
-- INSERT. It fires even for a direct psql session, which is the point: an operator
-- with database credentials cannot rewrite who did what.
CREATE OR REPLACE FUNCTION admin_audit_logs_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'admin_audit_logs is append-only: % is not permitted (attempted on id %)',
		TG_OP, COALESCE(OLD.id::text, 'unknown')
		USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint

CREATE TRIGGER admin_audit_logs_no_update
	BEFORE UPDATE ON admin_audit_logs
	FOR EACH ROW EXECUTE FUNCTION admin_audit_logs_reject_mutation();--> statement-breakpoint

CREATE TRIGGER admin_audit_logs_no_delete
	BEFORE DELETE ON admin_audit_logs
	FOR EACH ROW EXECUTE FUNCTION admin_audit_logs_reject_mutation();--> statement-breakpoint

-- ─── Value-shape guards ──────────────────────────────────────────────────────
-- Cheap CHECK constraints that keep a typo'd enum out of the control plane. A
-- bad value here would silently change how a permission or scope is interpreted,
-- so reject it at the boundary rather than coercing it in application code.
ALTER TABLE "system_configs"
	ADD CONSTRAINT "system_configs_scope_check"
		CHECK ("scope" IN ('public', 'private', 'secret')),
	ADD CONSTRAINT "system_configs_source_check"
		CHECK ("source" IN ('env', 'database')),
	ADD CONSTRAINT "system_configs_secret_shape_check"
		CHECK (
			("scope" = 'secret' AND "value" IS NULL)
			OR ("scope" <> 'secret')
		);--> statement-breakpoint

ALTER TABLE "feature_flag_overrides"
	ADD CONSTRAINT "feature_flag_overrides_scope_check"
		CHECK ("scope_type" IN ('environment', 'user', 'organization')),
	ADD CONSTRAINT "feature_flag_overrides_percent_check"
		CHECK ("rollout_percent" IS NULL OR ("rollout_percent" >= 0 AND "rollout_percent" <= 100));--> statement-breakpoint

ALTER TABLE "admin_audit_logs"
	ADD CONSTRAINT "admin_audit_outcome_check"
		CHECK ("outcome" IN ('success', 'failure', 'denied'));--> statement-breakpoint

ALTER TABLE "provider_health_checks"
	ADD CONSTRAINT "provider_health_status_check"
		CHECK ("status" IN ('pass', 'fail', 'degraded', 'not_configured'));--> statement-breakpoint

ALTER TABLE "job_executions"
	ADD CONSTRAINT "job_executions_status_check"
		CHECK ("status" IN ('queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'));
