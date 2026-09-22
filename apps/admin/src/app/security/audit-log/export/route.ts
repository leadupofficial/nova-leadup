/**
 * Audit-log export — the download endpoint.
 *
 * A route handler rather than a Server Action, because the result is a *file*: the browser has to
 * receive a `Content-Disposition: attachment` response with a filename, which a Server Action
 * cannot produce. It is a thin proxy: the filters on the query string are forwarded to the API
 * unchanged, and the API's `audit.export` permission is the only thing that decides whether a file
 * comes back.
 *
 * ## Why the token is not re-verified here
 *
 * This handler does not decide anything about authorisation. It forwards the operator's token and
 * returns whatever the API says, so there is exactly one authorisation decision in the system and
 * it is the server's. A 403 from the API becomes a 403 here with the API's own message, rather
 * than being pre-empted by a second, weaker check that could drift from the real one.
 */

import type { NextRequest } from 'next/server';
import { fetchAuditExportCsv } from '../../../../lib/api';

export const dynamic = 'force-dynamic';

/** The filters the API accepts, forwarded verbatim. */
const FILTERS = ['action', 'actorId', 'outcome', 'targetType', 'search', 'from', 'to'] as const;

export async function GET(request: NextRequest): Promise<Response> {
	const incoming = request.nextUrl.searchParams;
	const params: Record<string, string> = {};
	for (const name of FILTERS) {
		const value = incoming.get(name);
		if (value) params[name] = value;
	}

	try {
		const result = await fetchAuditExportCsv(params);
		const headers = new Headers({
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${result.filename}"`,
			// Surfaced to the browser as well as in the file's own header row, so the count is
			// visible without opening the download.
			'X-Nova-Export-Rows': String(result.rows),
			'X-Nova-Export-Truncated': result.truncated ? 'true' : 'false',
			'Cache-Control': 'no-store',
		});
		return new Response(result.csv, { status: 200, headers });
	} catch (error) {
		const status = (error as { status?: number }).status ?? 502;
		const message = error instanceof Error ? error.message : 'Could not export the audit log.';
		return new Response(`${message}\n`, {
			status,
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
		});
	}
}
