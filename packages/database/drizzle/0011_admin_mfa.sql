-- NOVA — administrator two-factor authentication.
--
-- §30 of the acceptance criteria lists MFA/2FA, and the control plane had none: an operator's
-- account was protected by a password alone, and that password also unlocks every other NOVA
-- surface, including the mobile app.
--
-- ## Why a separate table rather than columns on `users`
--
-- MFA is enrolled **per account and only for administrators**. Putting the secret on `users` would
-- mean every row carries a nullable credential column that nothing reads, and a future feature that
-- wants user-level MFA would then have to distinguish two enrolments in one place. A dedicated table
-- also means the row's existence is the statement "this account has a second factor", which is
-- easier to reason about than three columns that must agree.
--
-- ## The secret is encrypted, with the mechanism that already exists
--
-- `secret_ciphertext` holds the AES-256-GCM payload produced by `admin/secrets.ts` —
-- `v1:<iv>:<tag>:<ciphertext>` — the same format `system_configs.secret_ciphertext` uses. TOTP
-- secrets are long-lived credentials: anyone who reads one can generate valid codes forever, so
-- storing it in plaintext would make the second factor strictly weaker than the password it guards.
-- The `CHECK` mirrors the one on `system_configs`: a row cannot hold a secret without the ciphertext
-- column, so a future writer cannot quietly store plaintext.
--
-- ## Recovery codes are hashes, and are per-row JSON
--
-- A lost phone must not mean a lost platform, so enrolment issues ten single-use recovery codes.
-- They are stored as a JSON array of `{hash, usedAt}`: SHA-256 over a random 32-byte value, never
-- the code itself. A separate table would be more relational and is not worth it for a fixed-size
-- array that is always read and written whole.
--
-- `confirmed_at` is what makes enrolment safe: a secret is stored the moment enrolment starts, but
-- does not gate anything until the operator has proved they can generate a code from it. An
-- abandoned enrolment therefore cannot lock anybody out.
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS` plus a guarded foreign key, following 0006.

CREATE TABLE IF NOT EXISTS "admin_mfa" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	-- AES-256-GCM payload, `v1:<iv>:<tag>:<ciphertext>`. Never the raw base32 secret.
	"secret_ciphertext" text NOT NULL,
	-- NULL until the operator proves possession by submitting a valid code.
	"confirmed_at" timestamp,
	-- The last TOTP step accepted, so a code cannot be replayed inside its own drift window.
	"last_used_counter" bigint,
	-- `[{ "hash": "<sha256 hex>", "usedAt": null | "<iso>" }]`
	"recovery_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "admin_mfa_user_id_unique" UNIQUE("user_id"),
	-- The secret column is mandatory, so there is no "row without a secret" state to reason about.
	CONSTRAINT "admin_mfa_secret_present" CHECK (length("secret_ciphertext") > 0)
);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_mfa" ADD CONSTRAINT "admin_mfa_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_mfa_confirmed_idx" ON "admin_mfa" USING btree ("confirmed_at");
