/**
 * Server-side page loading that can express failure.
 *
 * Every data page in this console used to do:
 *
 * ```ts
 * try { return await listUsers(); } catch { return null; }
 * ```
 *
 * and then render `result ?? []`. A 401 from an expired cookie, a 500, or an
 * unreachable API were therefore indistinguishable from a genuinely empty table —
 * the page said **"No users found"** while the API had answered *"Missing or invalid
 * authorization header"*. Two of the three states a console must never confuse are
 * "you are not signed in" and "there is nothing here".
 *
 * This module turns a failed load into a `{ ok: false }` result carrying a message a
 * human can act on, so the page can say what actually happened.
 */

export type PageLoad<T> =
	| {
			ok: true;
			rows: T[];
			totalItems: number | null;
			totalPages: number | null;
			/**
			 * True when the API withheld end-user content from this response because the operator's
			 * role does not hold the matching `*.content_read` permission. Pages must say so; an
			 * empty cell reads as missing data rather than withheld data.
			 */
			contentRedacted: boolean;
			contentPermission?: string;
	  }
	| { ok: false; message: string; status: number | null };

const MESSAGES: Record<number, string> = {
	401: 'Your session has expired. Sign in again to view this page.',
	403: 'Your account does not have permission to view this page.',
	404: 'The admin API does not expose this endpoint.',
	429: 'Too many requests — the admin API is rate limiting this console. Try again shortly.',
	500: 'The admin API reported an internal error.',
	502: 'The admin API could not be reached through the proxy.',
	503: 'The admin API is not ready (its database or cache is unavailable).',
};

export function describeLoadError(error: unknown): { message: string; status: number | null } {
	const status =
		typeof (error as { status?: unknown })?.status === 'number'
			? ((error as { status: number }).status)
			: null;

	if (status && MESSAGES[status]) {
		return { message: MESSAGES[status], status };
	}
	if (status) {
		return { message: `The admin API answered ${status}.`, status };
	}

	const message = error instanceof Error ? error.message : String(error);
	// A bare network failure has no status; surfacing its text is more useful than
	// hiding it, and it contains no credentials.
	return { message: `Could not reach the admin API: ${message}`, status: null };
}

/**
 * Runs a loader and reports success or failure.
 *
 * [loader] returns the rows plus whatever pagination the endpoint supplied. Callers
 * that only have an array can pass `{ rows, totalItems: null, totalPages: null }`.
 */
export async function loadPage<T>(
	loader: () => Promise<{
		rows: T[];
		totalItems?: number | null;
		totalPages?: number | null;
		contentRedacted?: boolean;
		contentPermission?: string;
	}>,
): Promise<PageLoad<T>> {
	try {
		const result = await loader();
		return {
			ok: true,
			rows: result.rows,
			totalItems: result.totalItems ?? null,
			totalPages: result.totalPages ?? null,
			contentRedacted: result.contentRedacted === true,
			contentPermission: result.contentPermission,
		};
	} catch (error) {
		if (process.env.NODE_ENV !== 'production') {
			// Server-side only; the browser console never sees this.
			// eslint-disable-next-line no-console
			console.error('[admin-ui] page load failed:', error);
		}
		return { ok: false, ...describeLoadError(error) };
	}
}
