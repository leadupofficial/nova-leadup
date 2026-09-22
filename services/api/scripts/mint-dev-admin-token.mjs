/**
 * Development verification helper: mint an admin access token with the same HS256
 * claims the auth service issues, so the Control Center's permission gates can be
 * exercised end to end without an interactive login.
 *
 * Resolves the secret from files rather than the process environment:
 *
 *   1. `JWT_SECRET` in the real environment, when exported by a shell or CI.
 *   2. `services/api/.env`, located relative to THIS FILE, not the caller's cwd.
 *
 * Step 2 is a bug fix, not a convenience. The first version read `./.env`, so running
 * the verifier from the repository root loaded the *root* `.env` — which has a different
 * `JWT_SECRET` than the API process (which loads `services/api/.env`). A token signed
 * with the wrong secret is valid-looking and correctly shaped, and the API answers
 * `401 Invalid or expired token`; every admin call in the verification then looked like
 * an authorisation failure when the real fault was which file was read. Anchoring the
 * path to this module makes the script independent of the working directory.
 *
 * Read-only with respect to the database: it mints a token and prints it.
 */
import jwt from 'jsonwebtoken';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Minimal `KEY=value` parser; ignores comments and blank lines. */
function envFrom(path) {
	try {
		const out = {};
		for (const line of readFileSync(path, 'utf8').split('\n')) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(trimmed);
			if (match) out[match[1]] = match[2].replace(/^["']|["']$/g, '');
		}
		return out;
	} catch {
		return {};
	}
}

// `services/api/scripts/` -> `services/api/.env`
const envFile = join(here, '..', '.env');
const fileEnv = envFrom(envFile);

const secret = process.env.JWT_SECRET || fileEnv.JWT_SECRET;
if (!secret || secret.length < 32) {
	console.error(
		`JWT_SECRET not usable: set it in the environment or in ${envFile} (minimum 32 characters).`,
	);
	process.exit(1);
}

const role = process.argv[2] || 'owner';

/**
 * The `sub` claim, which must name a **real** account.
 *
 * This used to default to a hard-coded synthetic id (`0000…0001`). That was fine while nothing
 * checked whether the subject existed, and it stopped being fine when `authenticate` started
 * checking — a token for a deleted account is now refused with `403 ACCOUNT_DISABLED`, exactly as
 * a real client would experience. So the default is resolved from the database and the script
 * fails loudly if it cannot find an account, rather than minting a token every route rejects.
 *
 * **Which** account depends on the role being probed, because `resolveAdmin` prefers a database
 * grant over the token's claim. A probe that means to test the claim path must therefore use an
 * account with no grant — otherwise `token("admin")` inherits the super-admin grant of whatever
 * account happened to be picked and the probe silently tests the wrong thing. That is not
 * hypothetical: it made three checks in `verify-platform-roles.py` report that a PLATFORM_ADMIN
 * and a READ_ONLY operator could both grant roles.
 *
 *   * `owner` (and any role that must outrank a grant) → an account that already holds a grant;
 *   * every other role → an account with no grant, so the claim decides.
 */
async function resolveDefaultSubject(preferGranted) {
	const url = process.env.DATABASE_URL || fileEnv.DATABASE_URL;
	if (!url) return null;
	const { default: pg } = await import('pg');
	const client = new pg.Client({ connectionString: url });
	try {
		await client.connect();
		const query = preferGranted
			? `SELECT u.id FROM users u JOIN platform_admin_roles p ON p.user_id = u.id
			   WHERE NOT u.disabled ORDER BY p.created_at LIMIT 1`
			: `SELECT u.id FROM users u
			   WHERE NOT u.disabled AND NOT EXISTS (SELECT 1 FROM platform_admin_roles p WHERE p.user_id = u.id)
			   ORDER BY u.created_at LIMIT 1`;
		const row = await client.query(query);
		if (row.rows[0]?.id) return row.rows[0].id;

		// No ungranted account to fall back to for a claim-path probe. Returning the granted one
		// would produce a token that tests the grant path while claiming otherwise, so refuse.
		return null;
	} catch {
		return null;
	} finally {
		await client.end().catch(() => {});
	}
}

let sub = process.argv[3];
if (!sub) {
	sub = await resolveDefaultSubject(role === 'owner');
	if (!sub) {
		console.error(
			`No account to mint a ${role} token for.\n` +
				'Pass one explicitly: node mint-dev-admin-token.mjs <role> <user-uuid> [email].\n' +
				'A token whose `sub` is not a real user is refused by the API with ACCOUNT_DISABLED, and a\n' +
				`${role} probe needs an account with no platform grant, or the grant outranks the claim.`,
		);
		process.exit(1);
	}
}
const email = process.argv[4] || `verify-${role}@nova.test`;
const token = jwt.sign({ sub, email, role }, secret, {
	expiresIn: '30m',
	jwtid: `verify-${Date.now()}`,
});
console.log(token);
