-- NOVA — revocations shared between replicas.
--
-- The token denylist was an in-process `Map`, so a force-logout was immediate on the replica that
-- performed it and invisible everywhere else: the token kept working on the other instances until it
-- expired, up to fifteen minutes. The module's comment said to use Redis for a distributed deployment.
-- Redis is not running here, and Postgres is already the shared durable store on every request path,
-- so the revocation list lives here instead.
--
-- ## Why a table rather than a pub/sub message
--
-- A message would be faster and would lose revocations for any replica that was restarting at the
-- moment it was published — a security control that silently misses the one case it exists for. A row
-- is durable, and each replica pulls what it has not seen using the watermark described in
-- `middleware/token-denylist.ts`.
--
-- ## The guarantee, stated exactly
--
-- Within one poll interval (5 s) of the revocation, on any replica that can reach this database. It is
-- deliberately **not** "immediate everywhere": the local write is immediate, and the propagation is
-- bounded rather than instantaneous, because `isRevoked` runs on every authenticated request and
-- cannot afford a query. The console says so wherever it describes force-logout.
--
-- Rows are small and short-lived — `reap()` deletes any whose token expired more than an hour ago —
-- so the table stays proportional to revocations in the last token lifetime, not to history.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS "revoked_tokens" (
	-- The JWT id. The primary key is what makes a repeated revocation a no-op rather than a duplicate.
	"jti" varchar(120) PRIMARY KEY,
	-- The token's subject (`sub`), so a lookup for one user's token cannot match another's.
	"sub" varchar(100) NOT NULL,
	-- When the token would have expired anyway. Past this the row is meaningless.
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- The poll's only query: "everything revoked after my watermark, in order". Without this index it is a
-- sequential scan on every replica every five seconds.
CREATE INDEX IF NOT EXISTS "revoked_tokens_revoked_at_idx" ON "revoked_tokens" USING btree ("revoked_at");--> statement-breakpoint
-- The reaper's predicate.
CREATE INDEX IF NOT EXISTS "revoked_tokens_expires_idx" ON "revoked_tokens" USING btree ("expires_at");
