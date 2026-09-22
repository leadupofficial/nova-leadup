/**
 * The one path the browser sweep cannot cover: the sign-in form itself.
 *
 * `tests/admin-console.spec.ts` seeds a token straight into the cookie and localStorage, which is
 * what a *finished* login leaves behind — so it proves every page renders and says nothing about
 * whether a human can get in. That gap mattered: the console's login form was exercised against a
 * local API and never against the deployed one, and "the operator cannot sign in" is the failure
 * that makes every other check irrelevant.
 *
 * This drives the real form against whatever `ADMIN_BASE_URL` points at, types the credentials,
 * submits, and asserts the browser lands inside the console with a session cookie.
 *
 * Skipped unless `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set, because it is the one test in this
 * suite that needs a real password and it must never be run with a fixture against production.
 *
 * Usage:
 *   ADMIN_BASE_URL=https://admin.nova.leadup.in \
 *   ADMIN_EMAIL=admin@nova.leadup.in ADMIN_PASSWORD='…' \
 *     npx playwright test tests/admin-live-login.spec.ts
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.ADMIN_BASE_URL ?? 'http://127.0.0.1:3000';
const EMAIL = process.env.ADMIN_EMAIL ?? '';
const PASSWORD = process.env.ADMIN_PASSWORD ?? '';

test.describe('Admin Control Center — sign-in form', () => {
	test.skip(
		EMAIL === '' || PASSWORD === '',
		'ADMIN_EMAIL and ADMIN_PASSWORD are required; this is the only test that needs a real password',
	);

	// The default 30 s budget is too tight for a real sign-in against a remote host: it has to
	// cover a TLS handshake, hydration, the API round trip and the redirect, and a timeout here
	// reads as "the form is broken" rather than "the network was slow".
	test.setTimeout(90_000);

	test('the login form signs in and lands inside the console', async ({ page }) => {
		await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

		// Hydration first, and the submit button is the signal for it: the form disables that button
		// until a `useEffect` confirms React has attached. Filling before that is not merely early —
		// it *loses* the input. The inputs are controlled, so once React hydrates it renders them
		// from its own (empty) state and the typed values are gone; the first version of this test
		// did exactly that and the API answered `400 VALIDATION_ERROR: Password is required` against
		// a form that looked filled in on screen.
		const submit = page.locator('button[type="submit"]').first();
		await expect(submit).toBeEnabled({ timeout: 30_000 });
		await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
		await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD);

		await Promise.all([
			page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }).catch(() => {}),
			submit.click(),
		]);
		await page.waitForTimeout(2_000);

		// A refused sign-in leaves the operator on /login. Asserting the URL is what distinguishes
		// "the form worked" from "the form rendered an error and stayed put".
		expect(new URL(page.url()).pathname, `sign-in left us on ${page.url()}`).not.toContain('/login');

		// The console shell is the proof the session is usable, not merely present.
		await expect(page.locator('nav').first()).toBeVisible({ timeout: 20_000 });
		await page.waitForSelector('h1', { timeout: 20_000 });

		const cookie = (await page.context().cookies()).find((c) => c.name === 'admin_token');
		expect(cookie, 'sign-in did not set the admin_token cookie').toBeTruthy();

		// And the session must actually authorise something: a token that the API refuses leaves a
		// shell that renders with every panel empty.
		const body = (await page.locator('body').innerText()).trim();
		expect(body).not.toContain('Could not reach the admin API');
	});
});

/**
 * The console's write path, driven through the real UI.
 *
 * Every other test here reads. A form that renders and a server action that never fires look
 * identical from the outside, so this fills in the "Edit account details" card and asserts the
 * *change* is visible afterwards — the standard this suite holds itself to, because an assertion
 * on a success banner alone passes even when nothing was written.
 *
 * Skipped unless ADMIN_TEST_USER_ID names a disposable account. It deliberately refuses to run
 * against the account it signs in with: `PATCH /control/users/:id` is a real write and the point
 * of a test is not to edit the production administrator.
 */
test.describe('Admin Control Center — write path', () => {
	const TARGET = process.env.ADMIN_TEST_USER_ID ?? '';

	test.skip(TARGET === '', 'ADMIN_TEST_USER_ID is required; this test writes to that account');

	test('the edit form writes the change through to the API', async ({ page }) => {
		test.setTimeout(120_000);

		await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		const submit = page.locator('button[type="submit"]').first();
		await expect(submit).toBeEnabled({ timeout: 30_000 });
		await page.locator('input[type="email"], input[name="email"]').first().fill(EMAIL);
		await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD);
		await submit.click();
		await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

		await page.goto(`${BASE}/users/${TARGET}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
		await page.waitForSelector('h1', { timeout: 20_000 });

		// The two cards the API had no caller for.
		// Role-scoped: the card heading and the submit button carry the same words, so a text
		// locator matches two elements and strict mode rejects it.
		await expect(page.getByRole('heading', { name: 'Edit account details' })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Reset account state' })).toBeVisible();
		await expect(page.locator('input#edit-name')).toBeVisible();
		await expect(page.locator('input#reset-confirm')).toBeVisible();

		const newName = `Console Edit ${Date.now().toString().slice(-6)}`;
		await page.locator('input#edit-name').fill(newName);
		await page.locator('input#edit-reason').fill('automated console write-path verification');
		await page.locator('form:has(input#edit-name) button[type="submit"]').click();

		// The action redirects back with `?ok=`, and the page must show it.
		await page.waitForURL(/[?&]ok=/, { timeout: 30_000 });
		await page.waitForSelector('h1', { timeout: 20_000 });

		// The change itself, not the banner. This must be a retrying assertion: after `redirect()`
		// Next replaces the page via a client-side navigation, and the previous render's `<h1>` is
		// still in the DOM while the new payload streams. Reading `innerText()` once right after
		// `waitForSelector('h1')` therefore measured the *old* page and reported a failed write
		// against a database that already contained the new name — a false alarm caused by the
		// assertion, not by the write.
		await expect(page.locator('body')).toContainText(newName, { timeout: 20_000 });
	});
});
