-- Platform admin role grants (one row per account).
--
-- Idempotent, like 0006, because the DDL is applied both by `drizzle-kit` here and by the
-- guarded repair script when a database has been rebuilt.
CREATE TABLE IF NOT EXISTS "platform_admin_roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(50) NOT NULL,
	"granted_by" varchar(100),
	"granted_by_email" varchar(255),
	"reason" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "platform_admin_roles_user_id_unique" UNIQUE("user_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "platform_admin_roles_role_idx" ON "platform_admin_roles" USING btree ("role");--> statement-breakpoint

-- Foreign keys.
--
-- `schema-admin.ts` is deliberately import-free so one source can drive both `tsc` (Node ESM,
-- which needs a `.js` extension on relative imports) and `drizzle-kit generate` (CommonJS
-- require, which cannot resolve that extension). Its keys are therefore declared here.
--
-- NOTE: `drizzle-kit generate` also emitted DROP statements for the three 0006 foreign keys,
-- because from its point of view the schema no longer declares them. Those are deliberately
-- removed: the constraints exist and dropping them would silently remove referential
-- integrity from tables that already have it.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_admin_roles_user_id_users_id_fk') THEN
		ALTER TABLE "platform_admin_roles"
			ADD CONSTRAINT "platform_admin_roles_user_id_users_id_fk"
			FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END;
$$;--> statement-breakpoint

-- The role value is an enum in application code; the database guards it too, so a typo
-- cannot create a grant that silently maps to no permissions.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'platform_admin_roles_role_check') THEN
		ALTER TABLE "platform_admin_roles"
			ADD CONSTRAINT "platform_admin_roles_role_check"
			CHECK ("role" IN (
				'SUPER_ADMIN', 'PLATFORM_ADMIN', 'SUPPORT_ADMIN', 'OPERATIONS_ADMIN',
				'ANALYTICS_ADMIN', 'DEVELOPER', 'READ_ONLY'
			));
	END IF;
END;
$$;
