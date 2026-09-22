/**
 * Admin Control Center — real-browser acceptance test.
 *
 * Drives the running console in Chromium against the running API, with a real admin
 * token in the cookie and localStorage. For every destination it asserts that the page
 * renders **content**, not just that it returns 200:
 *
 *  - no Next.js error overlay
 *  - no framework error boundary text
 *  - an `<h1>` heading is present
 *  - the page is not a blank shell
 *
 * That distinction matters. A Server Component that throws on a bad query still returns
 * HTTP 200 with an error boundary in the body, which a status-code check reports as
 * healthy — and two of the bugs found during this work (a 500 on user detail from a
 * non-existent column, and a feature-flags page that threw the moment a flag existed)
 * would have passed a status-only test.
 *
 * It also exercises the paths that matter operationally: login gate, dashboard, a user
 * detail page, the flag list, configuration, and the audit log.
 *
 * Usage:
 *   node services/api/scripts/mint-dev-admin-token.mjs owner > /tmp/token
 *   ADMIN_BASE_URL=http://127.0.0.1:3000 ADMIN_TOKEN=$(cat /tmp/token) \
 *     npx playwright test tests/admin-console.spec.ts
 */
import { execFileSync } from 'node:child_process';
import { test, expect, type Page } from '@playwright/test';
import { NAV_GROUPS } from '../apps/admin/src/lib/nav';

const BASE = process.env.ADMIN_BASE_URL ?? 'http://127.0.0.1:3000';
// The API is called directly by a few tests that need to put the system into a specific state — a
// rotated credential — rather than read it. Same default as the console's own server-side base.
const API_BASE = process.env.ADMIN_API_BASE ?? 'http://127.0.0.1:3001/api/v1';
const TOKEN = process.env.ADMIN_TOKEN ?? '';

/**
 * Every Control Center destination, **derived from the console's own navigation model**.
 *
 * This list used to be typed by hand, and that is exactly how three destinations —
 * `/environment`, `/sessions` and `/ai/secrets` — shipped as navigation links with no page
 * behind them: the sweep only visited the pages that existed, so a 404 in the sidebar was
 * invisible to it, and the report could claim every destination had been verified in a
 * real browser. Reading `NAV_GROUPS` makes that class of drift impossible to hide, because
 * adding a link to the navigation automatically adds it here.
 *
 * The module is imported rather than the rendered DOM being scraped so a *build* failure
 * (the nav file itself) is caught too; the rendered sidebar is separately asserted to
 * match this model in "every navigation link resolves" below.
 */
const DESTINATIONS: Array<{ path: string; label: string; group: string }> = NAV_GROUPS.flatMap((group) =>
	group.items.map((item) => ({ path: item.href, label: item.label, group: group.label })),
);

/** Text that means "this page failed", whatever the HTTP status said. */
/** Assigned inside the flag test so a failure message says which branch was missing. */
let explainFlags = false;

const FAILURE_MARKERS = [
	'Application error',
	'a client-side exception has occurred',
	'Unhandled Runtime Error',
	'This page could not be found',
	'Internal Server Error',
];

async function seedSession(page: Page): Promise<void> {
	// The middleware reads `admin_token` from a cookie; the client guard reads it from
	// localStorage. Seeding both is what a real login does.
	await page.context().addCookies([
		{ name: 'admin_token', value: TOKEN, url: BASE, httpOnly: false, sameSite: 'Lax' },
	]);
	await page.addInitScript((token: string) => {
		try {
			window.localStorage.setItem('admin_token', token);
		} catch {
			/* storage unavailable */
		}
	}, TOKEN);
}

test.describe('Admin Control Center — destinations render', () => {
	test.skip(TOKEN === '', 'ADMIN_TOKEN is required; mint one with services/api/scripts/mint-dev-admin-token.mjs');

	for (const destination of DESTINATIONS) {
		test(`${destination.label} (${destination.path}) renders real content`, async ({ page }) => {
			await seedSession(page);

			const response = await page.goto(`${BASE}${destination.path}`, {
				waitUntil: 'domcontentloaded',
				timeout: 30_000,
			});

			// A 5xx is a hard failure; a 200 still has to pass the content checks below.
			if (response) {
				expect(response.status(), `${destination.path} returned ${response.status()}`).toBeLessThan(500);
			}

			// The console shell must be present, which proves the auth guard let us through
			// rather than bouncing to /login.
			await expect(page.locator('nav')).toBeVisible({ timeout: 15_000 });

			// Wait for the page's own `<h1>`, not just the shell.
			//
			// Next.js streams: the shell arrives first and the routed page's content follows.
			// Without this, `/users` was measured at 538 characters because the table had not
			// been streamed yet, which looks identical to a page that rendered nothing.
			await page.waitForSelector('h1', { timeout: 20_000 });

			const body = (await page.locator('body').innerText()).trim();
			for (const marker of FAILURE_MARKERS) {
				expect(body, `${destination.path} rendered a failure: found ${JSON.stringify(marker)}`).not.toContain(marker);
			}

			// A Server Component that threw would leave the heading absent.
			const heading = (await page.locator('h1').first().innerText().catch(() => '')).trim();
			expect(heading.length, `${destination.path} rendered no <h1>`).toBeGreaterThan(0);

			// Guard against a shell that renders but whose data never arrived. A page that
			// could not reach the API is a failure, not a pass: the console's own error card
			// is explicit about it and this sweep must honour that.
			expect(
				body,
				`${destination.path} could not reach the admin API`,
			).not.toContain('Could not reach the admin API');
			expect(
				body,
				`${destination.path} rendered an API error card`,
			).not.toMatch(/^Could not load/m);

			// A Next.js error boundary writes a digest into the streamed payload. Its presence
			// means a Server Component threw, whatever text is on screen — this is the check
			// that caught the Configuration page rendering header-only because the response key
			// it read (`entries`) did not exist (the API returns `configs`).
			const html = await page.content();
			expect(html, `${destination.path} rendered a React error digest`).not.toMatch(/digest\\?":\\?"\d{6,}/);

			// The presence of the page's own `<h1>` (awaited above) is what proves the routed
			// page rendered rather than just the shell. A length heuristic was tried and
			// removed: it flagged pages whose content is legitimately short (an empty state)
			// and passed pages whose Server Component had thrown while still emitting a
			// heading. The digest check above is the signal that actually distinguishes them.
		});
	}
});

test.describe('Admin Control Center — critical paths', () => {
	test.skip(TOKEN === '', 'ADMIN_TOKEN is required');

	/**
	 * Loads a page and returns its full rendered HTML.
	 *
	 * `domcontentloaded` plus explicit element waits, NOT `networkidle`: a Next.js app
	 * keeps connections open (prefetch, the HMR socket in dev), so `networkidle` never
	 * settles and the test times out even when the page is perfect. Waiting for `nav` and
	 * `h1` is both faster and a stronger assertion — it proves the console shell rendered
	 * *and* that the page produced a heading.
	 *
	 * `page.content()` rather than a locator's `innerText`: the server-rendered document is
	 * what an operator receives, and a locator scoped to one element silently misses text
	 * present elsewhere on the page.
	 */
	async function loadHtml(page: Page, path: string): Promise<string> {
		await seedSession(page);
		const response = await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		if (response) expect(response.status(), `${path} returned ${response.status()}`).toBeLessThan(500);
		await page.waitForSelector('nav', { timeout: 20_000 });
		await page.waitForSelector('h1', { timeout: 20_000 });
		return page.content();
	}

	test('an unauthenticated visitor is redirected to the login page', async ({ page }) => {
		await page.goto(`${BASE}/users`, { waitUntil: 'domcontentloaded' });
		await expect(page).toHaveURL(/\/login/);
	});

	test('every navigation link resolves to a real page', async ({ page }) => {
		// The regression this exists for: `/environment`, `/sessions` and `/ai/secrets` were
		// rendered as sidebar links while no page existed at those paths, so an operator
		// clicking them got a 404. The destination sweep could not see it because its list
		// was typed by hand and matched the pages on disk. Here the links come from the
		// rendered shell — whatever is actually clickable — and each one must answer with a
		// page, not a "could not be found".
		await seedSession(page);
		await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		await page.waitForSelector('nav', { timeout: 20_000 });

		const hrefs = await page.locator('nav a[href^="/"]').evaluateAll((anchors) =>
			Array.from(new Set(anchors.map((anchor) => (anchor as HTMLAnchorElement).getAttribute('href') ?? ''))).filter(
				Boolean,
			),
		);
		expect(hrefs.length, 'the sidebar rendered no navigation links').toBeGreaterThan(0);

		// And the rendered shell must offer every destination the model declares. Without this
		// the loop below could pass by navigating a sidebar that had quietly lost half its links,
		// which is the same failure mode in the other direction.
		for (const destination of DESTINATIONS) {
			expect(hrefs, `the sidebar does not link to ${destination.path}`).toContain(destination.path);
		}

		for (const href of hrefs) {
			const response = await page.goto(`${BASE}${href}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
			expect(response?.status(), `sidebar link ${href} returned ${response?.status()}`).toBe(200);
			await page.waitForSelector('h1', { timeout: 20_000 });
			const text = await page.locator('body').innerText();
			expect(text, `sidebar link ${href} rendered a 404 page`).not.toContain('This page could not be found');
			expect(text, `sidebar link ${href} rendered a failure`).not.toContain('Application error');
		}
	});

	test('the dashboard shows real platform figures and admits what it cannot compute', async ({ page }) => {
		const html = await loadHtml(page, '/');
		expect(html).toContain('Total users');
		// A real figure from the live database, not a placeholder.
		expect(html).toMatch(/Total users[\s\S]{0,400}?[\d,]{2,}/);
		// The honesty contract: an uncomputable metric must say NOT AVAILABLE, never 0.
		expect(html).toContain('NOT AVAILABLE');
	});

	test('opening a user shows the real NOVA state for that account', async ({ page }) => {
		await seedSession(page);
		await page.goto(`${BASE}/users`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		await page.waitForSelector('h1', { timeout: 20_000 });

		// The table is streamed after the shell, so the link may not exist yet when the heading
		// appears. Wait for *either* a row or the empty state before deciding — reading the count
		// immediately made this test skip intermittently on a database that has users, which
		// reads as "no data" rather than "too early".
		const firstUserLink = page.locator('a[href^="/users/"]').first();
		await Promise.race([
			firstUserLink.waitFor({ state: 'attached', timeout: 20_000 }).catch(() => null),
			page.locator('text=No accounts').first().waitFor({ state: 'attached', timeout: 20_000 }).catch(() => null),
		]);

		if ((await firstUserLink.count()) === 0) {
			test.skip(true, 'No users in this database to open');
		}
		await firstUserLink.click();
		await expect(page).toHaveURL(/\/users\/[0-9a-f-]+/);
		await page.waitForSelector('h1', { timeout: 20_000 });
		// The capability table is the last section to render, so waiting for it proves the
		// whole aggregated payload arrived.
		await page.waitForSelector('text=Capability checks', { timeout: 20_000 });

		const html = await page.content();
		expect(html).toContain('NOVA status for this account');
		expect(html).toContain('Proactive assistant');
	});

	test('the feature-flag page demonstrates deterministic rollout', async ({ page }) => {
		const html = await loadHtml(page, '/feature-flags');
		expect(html).toContain('Feature Flags');
		expect(html).toContain('stable hash');
	});

	test('the configuration page labels every key live or not-wired', async ({ page }) => {
		const html = await loadHtml(page, '/configuration');
		expect(html).toContain('Configuration');
		expect(/not wired|>live</.test(html)).toBe(true);
		expect(/secret|encrypt/i.test(html)).toBe(true);
	});

	test('the emergency controls page states what each switch breaks', async ({ page }) => {
		const html = await loadHtml(page, '/maintenance');
		expect(html).toContain('kill switches');
		expect(/refused with 503|No LLM call is attempted|Typed chat still works|Text only/i.test(html)).toBe(true);
	});

	/**
	 * The sign-in form submitted as a **GET** before React hydrated, and put the password in the URL.
	 *
	 * This was found by driving the deployed console's login form rather than by seeding a token
	 * into the cookie, which is all the rest of this suite does. The form has an `onSubmit` that
	 * calls `preventDefault`, and no `method` — so with no JavaScript, with JavaScript still
	 * loading, or after a hydration failure, the browser owns the submit and serialises every
	 * field into the query string. The address bar read
	 * `/login?email=…&password=<the real password>` and nginx logged it.
	 *
	 * JavaScript is disabled here on purpose: that is precisely the state in which the
	 * `onSubmit` handler does not exist, so assertion on the server's own HTML is the only
	 * check that covers the failure. A hydrated form is exercised by
	 * `tests/admin-live-login.spec.ts`.
	 */
	test('the sign-in form cannot leak credentials before React hydrates', async ({ browser }) => {
		const context = await browser.newContext({ javaScriptEnabled: false });
		const page = await context.newPage();
		try {
			await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
			const form = page.locator('form[aria-label="Admin login form"]');
			await expect(form).toBeVisible();

			// POST, not the default GET: an unhydrated submit must not put a password in the URL.
			await expect(form).toHaveAttribute('method', 'post');

			// And the submit is inert until hydration anyway, so the operator cannot fire a
			// submit whose handler does not exist yet.
			await expect(form.locator('button[type="submit"]')).toBeDisabled();
		} finally {
			await context.close();
		}
	});

	test('the audit log states its append-only guarantee', async ({ page }) => {
		const html = await loadHtml(page, '/security/audit-log');
		expect(html).toContain('Admin Audit Log');
		expect(html.toLowerCase()).toContain('append-only');
	});

	/**
	 * The filter form and the CSV export read the same `query` object, and they did not always.
	 *
	 * The API and the export endpoint accepted a `from`/`to` date range while the page had no
	 * date inputs at all, so the export offered "exactly the rows the current filters select" and
	 * silently ignored a range the operator could not set in the first place. This asserts the two
	 * halves move together: the inputs exist as date pickers, and the export link carries them.
	 */
	test('the audit log date filter and its export carry the same range', async ({ page }) => {
		await loadHtml(page, '/security/audit-log');
		await expect(page.locator('input#audit-from')).toHaveAttribute('type', 'datetime-local');
		await expect(page.locator('input#audit-to')).toHaveAttribute('type', 'datetime-local');

		await loadHtml(page, '/security/audit-log?from=2026-01-01T00:00&to=2026-01-02T00:00');
		const href = await page.locator('a[href^="/security/audit-log/export"]').first().getAttribute('href');
		expect(href).toBeTruthy();
		const exported = new URL(href!, 'http://console.invalid').searchParams;

		// `datetime-local` means wall-clock time in the operator's own zone, so the instant for
		// 2026-01-01T00:00 depends on where the browser is. Assert the conversion rather than a
		// fixed UTC string: what must hold is that the export and the picker agree.
		const shownFrom = await page.locator('input#audit-from').inputValue();
		expect(shownFrom).toBe('2026-01-01T00:00');
		expect(exported.get('from')).toBe(new Date('2026-01-01T00:00').toISOString());
		expect(exported.get('to')).toBe(new Date('2026-01-02T00:00').toISOString());
		// The range must come back into the pickers, or re-submitting the form would drop it.
		expect(new Date(shownFrom).toISOString()).toBe(exported.get('from'));
	});

	/**
	 * The three destinations below were navigation links with no page behind them.
	 *
	 * They are covered by the generated sweep above for "renders something", but a page can render
	 * an <h1> and still be useless. These assert the specific claim each page exists to make, which
	 * is what a 404 or a half-built stub would fail.
	 */
	test('the environment page states which deployment this console is acting on', async ({ page }) => {
		await loadHtml(page, '/environment');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Deployment identity');
		expect(text).toContain('NODE_ENV');
		// The verdict must be explicit in one direction or the other — never silent.
		expect(/PRODUCTION|NOT the production deployment/.test(text)).toBe(true);
		// And it must say what is already switched off here, which is the pre-flight question.
		expect(text).toMatch(/switched off|Maintenance mode/);
	});

	test('the sessions page states how long a revocation takes to bite', async ({ page }) => {
		await loadHtml(page, '/sessions');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Sessions');
		// A session list must not imply an instant logout: access tokens are not re-checked.
		expect(text.toLowerCase()).toMatch(/refresh token|access token/);
		expect(text).toMatch(/active|revoked|expired/);
	});

	test('the API key page reports test coverage rather than claiming "never tested"', async ({ page }) => {
		await loadHtml(page, '/ai/secrets');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Provider credentials');
		expect(text).toContain('Provider readiness');
		// Coverage is stated per credential. Before the read model joined `provider_health_checks`,
		// every key read "never tested" while the health table held results from minutes earlier.
		expect(text).toMatch(/connectivity test|no connectivity test covers this key/);
	});

	test('the AI providers page renders provider ids and models, not blank cells', async ({ page }) => {
		// Two reader bugs lived here: the page read `provider.provider` and `provider.lastHealth`
		// while the API sends `id` and `health`, and it called `.join()` on `{id, use}` model
		// objects. The visible symptoms were blank ids, a false "never tested" on every provider,
		// and `[object Object]` in the models column — none of which a status or heading check sees.
		await loadHtml(page, '/ai');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Providers');
		expect(text).not.toContain('[object Object]');
		// A provider the catalog always knows about, rendered by id.
		expect(text).toMatch(/anthropic/);
		// Model rows must carry a real model id and the API's explanation of it.
		expect(text).toMatch(/price-table family|configured default/);
	});

	test('the reminders page distinguishes "acknowledged" from "overdue"', async ({ page }) => {
		// These were the same thing until `reminders.triggered_at` got a writer: the page
		// said as much in a caveat, because nothing recorded that a user had seen a
		// reminder. It must now report the acknowledgement *and* keep saying that the alarm
		// itself fires on the device — which is what makes this an acknowledgement and not
		// a delivery record.
		await loadHtml(page, '/reminders');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Reminders');
		expect(text).toMatch(/Acknowledged/);
		expect(text.toLowerCase()).toContain('notification');
		expect(text).not.toMatch(/delivered to the device/);
	});

	test('the admin sessions page offers an immediate end and refuses it on your own row', async ({ page }) => {
		// `admin_sessions` had no writer before this: the table was permanently empty and there was
		// no way to end another operator's console session at all. The page must now list real
		// sessions, say which one is the caller's, and explain the propagation rather than implying
		// a global instant sign-out.
		await loadHtml(page, '/security/sessions');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Admin Sessions');
		// Case-insensitive: `Metric` renders its label through `text-transform: uppercase`, and
		// `innerText` reports the transformed text rather than the source string.
		expect(text).toMatch(/active sessions/i);
		expect(text).toMatch(/End session|this session/);
		// The denylist is what makes a revocation immediate; the page has to say so, and must not
		// claim it reaches every replica instantly.
		expect(text.toLowerCase()).toMatch(/denylist|next request/);
		expect(text).toMatch(/Sign out to end it/);
	});

	test('the audit log offers an export that really downloads a CSV', async ({ page }) => {
		// `audit.export` existed as a permission with no route, and the page said so rather than
		// offering a button that did nothing. The assertion is on the *response*, not the button:
		// a link that 500s would satisfy a "the control is present" check.
		await loadHtml(page, '/security/audit-log');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Admin Audit Log');
		expect(text).toContain('Export CSV');
		// The stale copy must be gone, or the page is contradicting itself.
		expect(text).not.toContain('Export is not offered yet');
		expect(text).not.toContain('no route implements it');

		// Fetch the download endpoint with the same session and check it is a real CSV file.
		const response = await page.request.get(`${BASE}/security/audit-log/export?outcome=denied`, {
			headers: { Cookie: `admin_token=${TOKEN}` },
		});
		expect(response.status(), 'the export endpoint must answer').toBe(200);
		expect(response.headers()['content-type']).toContain('text/csv');
		expect(response.headers()['content-disposition']).toContain('attachment');
		const body = await response.text();
		expect(body.split('\r\n')[0]).toContain('occurred_at,action,outcome');
	});

	test('the security overview reports real signals and its own limits', async ({ page }) => {
		// §29's dashboard. The page is only worth having if it says something a count cannot: the
		// reasons failures failed, which addresses were tried, and what the platform does *not*
		// detect. `no anomaly scoring` is asserted because dropping that line would let the page
		// imply coverage it does not have.
		await loadHtml(page, '/security');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Security Overview');
		expect(text).toMatch(/Failed sign-ins/i);
		expect(text).toContain('Watchlist');
		expect(text).toMatch(/Refused privileged actions/i);
		expect(text).toMatch(/Credential status/i);
		// Every configured-but-untested credential must read as unknown, never as healthy.
		expect(text).toMatch(/no test recorded|no connectivity test covers this key/);
	});

	test('two-factor enrolment is offered, and the page is honest about what is enforced', async ({ page }) => {
		// `MfaPanel` is a client component, so this has to be a real browser test: the control does
		// not exist in the server HTML at all, only after hydration.
		await loadHtml(page, '/security/mfa');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Two-Factor Authentication');
		// The anti-lockout property has to be visible, not just implemented: an operator who believes
		// an abandoned enrolment locks them out will not start one.
		expect(text).toMatch(/unconfirmed enrolment is not enforced/i);
		expect(text).toMatch(/shown once/i);
		// Either state is correct depending on whether the account has enrolled; the control must be
		// present in one of them.
		expect(text).toMatch(/Start enrolment|Replace recovery codes|Disable two-factor/i);
	});

	test('the security overview reports how many administrators hold a second factor', async ({ page }) => {
		// "Available" must not read as "in use", so the coverage counts are on the dashboard rather
		// than only on the page an operator visits to enrol.
		await loadHtml(page, '/security');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Two-factor authentication coverage');
		expect(text).toMatch(/Administrators without a factor/i);
	});

	test('the login form asks for a verification code when the API requires one', async ({ page }) => {
		// The interactive branch, driven by the API's own error code rather than by a real enrolled
		// account: `MFA_REQUIRED` is what the API answers, and the form must reveal a code field
		// instead of reporting a wrong password — which is the defect this prevents.
		// The console posts to the API on a different origin, so this is a preflighted CORS request.
		// Without the preflight and the `Allow-Origin` header the browser fails the fetch itself and
		// the form shows a network error — which is what the first version of this test hit.
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Headers': '*',
			'Access-Control-Allow-Methods': 'POST, OPTIONS',
		};
		await page.route('**/auth/login', async (route) => {
			if (route.request().method() === 'OPTIONS') {
				await route.fulfill({ status: 204, headers: corsHeaders });
				return;
			}
			await route.fulfill({
				status: 401,
				headers: corsHeaders,
				contentType: 'application/json',
				body: JSON.stringify({
					success: false,
					code: 'MFA_REQUIRED',
					message: 'A verification code is required for this account',
				}),
			});
		});

		// This test needs the *unauthenticated* login page, and every other test in this file runs with
		// a session cookie. Without clearing it the guard redirects away from `/login` and the test
		// fails on a timeout that looks like a broken form — it passed in isolation and failed in the
		// full sweep for exactly that reason. A test that depends on being signed out has to say so.
		await page.context().clearCookies();
		await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
		await page.evaluate(() => window.localStorage.clear());
		await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
		await page.fill('input[name="email"]', 'operator@example.com');
		await page.fill('input[name="password"]', 'not-a-real-password');
		await page.click('button[type="submit"]');

		const codeField = page.locator('input[name="mfaCode"]');
		// 15s rather than 5: this assertion depends on hydration plus a fetch, and in a 56-test sweep
		// the machine is loaded enough that 5s flaked — it failed in the full run and passed alone,
		// twice. The bound is still a bound: if the field never appears the test fails.
		await codeField.waitFor({ state: 'visible', timeout: 15000 });
		expect(await codeField.isVisible()).toBe(true);
		// It must not have claimed the password was wrong.
		const body = await page.locator('body').innerText();
		expect(body).not.toMatch(/invalid credentials|incorrect password|login failed/i);
	});

	test('a credential rotated after its last test is labelled, not reported as healthy', async ({
		page,
	}) => {
		// The defect this covers: `provider_health_checks` recorded a result but not which value it
		// tested, so after a rotation a `pass` kept asserting that a credential works for a value
		// that had already been replaced. The assertion is on the rendered page, because the fix is
		// a *label* — the data being right is not enough if the console still shows a green badge.
		const KEY = 'ANTHROPIC_API_KEY';
		const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

		// Make the recorded test describe a value that is no longer in force.
		const rotate = await page.request.put(`${API_BASE}/control/config/secrets/${KEY}`, {
			headers: auth,
			data: { value: 'sk-ant-browser-check-placeholder', reason: 'browser staleness check' },
		});
		expect(rotate.status(), 'the rotation must succeed for this test to mean anything').toBe(200);

		try {
			await loadHtml(page, '/ai/secrets');
			const text = await page.locator('body').innerText();
			expect(text).toContain('tested a previous value');
			// And the honest consequence: the key is not claimed to be verified.
			expect(text).toMatch(/replaced after this test|Run it again to confirm/i);
		} finally {
			// Restore the environment value whatever happened. A probe that leaves a placeholder in a
			// credential is worse than the defect it was written to find.
			const restored = await page.request.delete(`${API_BASE}/control/config/secrets/${KEY}`, {
				headers: auth,
				data: { reason: 'browser staleness check complete', confirm: KEY },
			});
			expect(restored.status(), 'the placeholder must be removed').toBe(200);

			// Re-test so the recorded result describes the restored value again.
			await page.request.post(`${API_BASE}/control/config/test/anthropic`, {
				headers: auth,
				data: {},
			});
		}
	});

	test('the log centre shows stored entries, and a correlation link reaches the trace', async ({
		page,
	}) => {
		// The page used to say there was no log store and name the fix. This asserts the fix is real
		// from the browser: a row the API actually wrote, with a link that resolves to a timeline.
		// `page.request` produces the error the API stores, so the assertion does not depend on
		// whatever happened to be logged earlier.
		const correlationId = `browser-log-check-${Date.now()}`;
		await page.request.post(`${API_BASE}/auth/login`, {
			headers: { 'Content-Type': 'application/json', 'X-Request-Id': correlationId },
			data: { email: 'nobody@example.invalid', password: 'WrongPassword1!' },
		});

		// The sink flushes on a timer, so give it a moment rather than asserting against a race.
		await new Promise((resolve) => setTimeout(resolve, 3000));

		await loadHtml(page, `/logs?requestId=${correlationId}`);
		const text = await page.locator('body').innerText();
		expect(text).toContain('Log centre');
		expect(text).toMatch(/entries at warn and above|entry at warn and above/);
		// The row itself: the failed request is in the table, with its correlation id.
		expect(text).toContain(correlationId);
		expect(text).toMatch(/POST \/api\/v1\/auth\/login/);
		// And the caveat that makes an empty table honest stays on the page.
		expect(text).toMatch(/Only entries at warn and above are persisted/i);

		// The correlation link must reach a timeline — the log line is what makes a failed request
		// traceable, since the other sources have no record of a 401.
		await loadHtml(page, `/logs?traceId=${correlationId}`);
		const traceText = await page.locator('body').innerText();
		expect(traceText).toContain('Timeline');
		// `StatusBadge` renders a label with underscores replaced by spaces, so the source reads
		// "service logs" on screen. Asserting the table name would be asserting the database.
		expect(traceText).toMatch(/service logs/i);
	});

	test('the navigation shows what the server allows, not what the token claims', async ({ page }) => {
		// The console used to resolve the role claim against its own copy of the matrix, which could not
		// see a database grant — the grant overrides the claim, so the console could offer destinations
		// the API refuses and hide ones it allows. It now asks `/control/me/permissions`.
		//
		// A READ_ONLY operator holding four permissions is the sharpest contrast available: a
		// SUPER_ADMIN sees every group, and the destinations READ_ONLY may not reach must be absent
		// rather than merely disabled.
		const readOnlyToken = execFileSync(
			'node',
			['services/api/scripts/mint-dev-admin-token.mjs', 'read_only'],
			{ cwd: process.cwd() },
		)
			.toString()
			.trim();

		await page.context().clearCookies();
		await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
		await page.evaluate((token) => {
			window.localStorage.setItem('admin_token', token);
		}, readOnlyToken);
		// The cookie is what the server-rendered pages read; the localStorage copy is what the client
		// guard uses. Both are set the way `writeTokens` does it.
		await page.context().addCookies([
			{ name: 'admin_token', value: readOnlyToken, url: BASE, sameSite: 'Lax' },
		]);

		await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
		await page.waitForTimeout(1500);
		// Scoped to the navigation. The body carries page content, and a metric labelled "Users" on the
		// dashboard is not a destination — the first version of this assertion checked the whole page and
		// failed on exactly that.
		const text = await page.locator('aside, nav').first().innerText();

		// READ_ONLY holds four permissions — analytics.read, services.read, config.read,
		// feature_flags.read — so the nav must offer exactly the destinations those unlock. The
		// assertion is on destinations rather than on the footer's permission count, because the count
		// lives in the account dropdown and the destinations are what an operator actually acts on.
		expect(text).toMatch(/Services/);
		expect(text).toMatch(/Feature Flags/);
		// Destinations it cannot open must be absent, not merely disabled: offering a link that answers
		// 403 is the failure this whole change removes.
		expect(text).not.toContain('Kill Switches');
		expect(text).not.toContain('Admins & Roles');
		expect(text).not.toMatch(/\bUsers\b/);
	});

	test('the permission page renders the catalogue the API enforces', async ({ page }) => {
		// The page used to render a hand-maintained copy of the catalogue. It now renders the API's, so
		// the count an operator reads is the count the server holds — and `admin_users.read` gates it,
		// which is why a SUPER_ADMIN can open it.
		await loadHtml(page, '/permissions');
		const text = await page.locator('body').innerText();
		expect(text).toContain('Permissions & Roles');
		// A permission whose description only exists server-side proves the data is not hardcoded here.
		expect(text).toContain('config.secrets');
		expect(text).toMatch(/Write, rotate and delete encrypted secrets/i);
		expect(text).toMatch(/SUPER_ADMIN/);
		expect(text).toMatch(/READ_ONLY/);
	});

	test('the dashboard reports the reminder acknowledgement figure', async ({ page }) => {
		await loadHtml(page, '/');
		const text = await page.locator('body').innerText();
		// Named for what is measured. "Executed" was the old label and was never true: the
		// writer records the user opening the notification, not the platform delivering it.
		expect(text).toMatch(/reminders acknowledged/i);
	});
});
