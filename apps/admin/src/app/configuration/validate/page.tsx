/**
 * Admin Control Center — configuration validator.
 *
 * The screen that answers "is this deployment actually wired up?" It combines two
 * different kinds of check, and keeping them distinct is the point:
 *
 *  - **Declared configuration**: which keys have a value from any source, and which do
 *    not. This catches "missing environment variable".
 *  - **Live connectivity**: a real authenticated call to every provider. This catches
 *    "the key is present but the provider rejects it" — the case a
 *    presence-only check reports as healthy, and the reason the old Anthropic check was
 *    replaced.
 *
 * Running the live half makes real network calls, so it is an explicit button rather
 * than something that fires on every page view.
 */

import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { testAllProviders, validateConfig } from '../../../lib/api';
import { loadPage } from '../../../lib/page-data';
import { PageError } from '../../../components/PageError';
import {
	Card,
	Cell,
	EmptyState,
	Metric,
	MetricGrid,
	Notes,
	PageHeader,
	Row,
	StatusBadge,
	Table,
} from '../../../components/ui';

export const dynamic = 'force-dynamic';

type Check = {
	key: string;
	label: string;
	category: string;
	status: 'pass' | 'fail' | 'degraded' | 'not_configured' | 'unset';
	required: boolean;
	detail: string;
	effectiveSource: string;
};

/** Runs the live provider checks, then re-renders so the result is read back from the API. */
async function runLiveChecks(): Promise<void> {
	'use server';
	await testAllProviders();
	revalidatePath('/configuration/validate');
}

const STATUS_ORDER: Record<string, number> = { fail: 0, unset: 1, not_configured: 2, degraded: 3, pass: 4 };

export default async function ConfigValidatorPage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const onlyProblems = (Array.isArray(resolved.problems) ? resolved.problems[0] : resolved.problems) === 'true';

	const result = await loadPage<Awaited<ReturnType<typeof validateConfig>>>(async () => {
		const data = await validateConfig();
		return { rows: [data] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Configuration Validator" />
				<PageError
					title="Could not validate configuration"
					message={result.message}
					status={result.status}
					retryHref="/configuration/validate"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	const checks: Check[] = (payload?.checks ?? []) as Check[];
	const summary = payload?.summary ?? {};

	const problems = checks.filter((check) => check.status !== 'pass');
	// Sorted worst-first: an operator opening this page wants the failures at the top,
	// not alphabetically interleaved with passes.
	const visible = (onlyProblems ? problems : checks)
		.slice()
		.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.key.localeCompare(b.key));

	return (
		<div>
			<PageHeader
				title="Configuration Validator"
				subtitle={`Environment: ${payload?.environment ?? 'unknown'} · ${checks.length} check(s), ${problems.length} needing attention`}
				actions={
					<div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
						<Link
							href={onlyProblems ? '/configuration/validate' : '/configuration/validate?problems=true'}
							style={{ fontSize: '0.78rem', color: '#2563eb', alignSelf: 'center' }}
						>
							{onlyProblems ? 'Show all checks' : 'Show problems only'}
						</Link>
						<form action={runLiveChecks}>
							<button
								type="submit"
								style={{
									padding: '0.5rem 1rem',
									background: '#1a1a2e',
									color: '#fff',
									border: 'none',
									borderRadius: '6px',
									fontSize: '0.82rem',
									cursor: 'pointer',
								}}
							>
								Run live provider checks
							</button>
						</form>
					</div>
				}
			/>

			<MetricGrid minWidth={150}>
				<Metric label="Passing" value={summary.pass ?? 0} tone="good" />
				<Metric label="Failing" value={summary.fail ?? 0} tone={(summary.fail ?? 0) > 0 ? 'bad' : 'default'} />
				<Metric label="Degraded" value={summary.degraded ?? 0} tone={(summary.degraded ?? 0) > 0 ? 'warn' : 'default'} />
				<Metric label="Not configured" value={summary.not_configured ?? 0} />
				<Metric label="Unset" value={summary.unset ?? 0} tone={(summary.unset ?? 0) > 0 ? 'warn' : 'default'} />
			</MetricGrid>

			<Notes
				notes={[
					...(payload?.notes ?? []),
					'A key being present is not the same as a provider working. The live half of this page makes a real authenticated call with the configured credential; “pass” here means the provider answered, not that a string looked plausible.',
					'“Run live provider checks” performs network calls to every configured provider. The Sarvam check performs a one-character synthesis, which is billed — it is labelled as such in its method.',
				]}
				tone={(summary.fail ?? 0) > 0 ? 'warn' : 'info'}
			/>

			<Card title="Checks" subtitle="Worst first, so failures are not buried among passes">
				{visible.length === 0 ? (
					<EmptyState message="No problems found" hint="Every declared key has a value and every configured provider answered." />
				) : (
					<Table columns={['Check', 'Category', 'Status', 'Source', 'Detail']}>
						{visible.map((check) => (
							<Row key={check.key}>
								<Cell>
									<div style={{ fontWeight: 500 }}>{check.label}</div>
									<div style={{ fontSize: '0.68rem', color: '#9ca3af', fontFamily: 'ui-monospace, Menlo, monospace' }}>
										{check.key}
									</div>
								</Cell>
								<Cell muted>{check.category}</Cell>
								<Cell>
									<StatusBadge status={check.status} />
									{check.required ? (
										<div style={{ fontSize: '0.66rem', color: '#d97706' }}>no fallback</div>
									) : null}
								</Cell>
								<Cell muted>{check.effectiveSource}</Cell>
								<Cell muted>
									<div style={{ maxWidth: '520px', fontSize: '0.78rem' }}>{check.detail}</div>
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Notes
				notes={[
					'Configuration values are edited on the Configuration page; environment-only keys (DATABASE_URL, JWT_SECRET) cannot be changed from the console at all and are reported here so their status is still visible.',
					'A green line here does not mean “production ready”: it means this environment can reach the services it is configured to use, from this process.',
				]}
			/>
		</div>
	);
}
