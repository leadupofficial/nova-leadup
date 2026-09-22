/**
 * Admin Control Center — shared list-page renderer.
 *
 * Six operations pages (jobs, notifications, memory, conversations, tool executions,
 * proactive) differ only in their columns and their honesty notes. Rather than six
 * near-identical files that drift apart, they share this renderer.
 *
 * Deliberately **presentational and synchronous**: it renders what it is given. The async
 * data loading lives in each page, so filtering stays in the URL and is applied
 * server-side by the API — a page is a link an operator can paste into an incident
 * channel, and no production table reaches the browser.
 */

import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState, Notes, PageHeader, Table, formatNumber } from './ui';

export type Column<T> = {
	header: string;
	render: (row: T) => ReactNode;
	align?: 'left' | 'right' | 'center';
};

export type FilterOption = {
	name: string;
	label: string;
	options: Array<{ value: string; label: string }>;
};

export type ListViewProps<T> = {
	title: string;
	/** API path under the console's proxy, used for pager links and the retry target. */
	path: string;
	columns: Array<Column<T>>;
	rows: T[];
	totalItems: number | null;
	totalPages: number | null;
	page: number;
	/** Current filter values, echoed back into the form and the pager links. */
	query: Record<string, string>;
	filters?: FilterOption[];
	searchParam?: string | null;
	searchPlaceholder?: string;
	searchValue?: string;
	notes?: Array<string | null | undefined>;
	emptyMessage: string;
	emptyHint?: string;
	rowKey: (row: T) => string;
	/** Optional per-row action, e.g. "Inspect user". */
	actions?: ReactNode;
};

export function countLabel(totalItems: number | null, rows: number, filtered: boolean): string {
	if (totalItems === null) return `Showing ${rows}`;
	return `${formatNumber(totalItems)} record(s)${filtered ? ' matching this filter' : ''}`;
}

export function ListView<T>(props: ListViewProps<T>): ReactNode {
	const queryString = new URLSearchParams(props.query).toString();
	const href = (next: number) =>
		`/${props.path}?${new URLSearchParams({ ...props.query, page: String(next) }).toString()}`;

	return (
		<div>
			<PageHeader title={props.title} subtitle={countLabel(props.totalItems, props.rows.length, queryString !== '')} />

			<Notes notes={props.notes ?? []} tone="warn" />

			{/* Filters are a GET form so the filtered view is a bookmarkable URL and the
			    API does the filtering, not the browser. */}
			{props.filters?.length || props.searchParam ? (
				<form method="get" style={styles.filterBar}>
					{props.searchParam ? (
						<div style={{ flex: '2 1 260px' }}>
							<label htmlFor="q" style={styles.label}>
								Search
							</label>
							<input
								id="q"
								name={props.searchParam}
								defaultValue={props.searchValue ?? ''}
								placeholder={props.searchPlaceholder}
								style={{ ...styles.input, width: '100%' }}
							/>
						</div>
					) : null}
					{(props.filters ?? []).map((filter) => (
						<div key={filter.name} style={{ flex: '1 1 170px' }}>
							<label htmlFor={filter.name} style={styles.label}>
								{filter.label}
							</label>
							<select
								id={filter.name}
								name={filter.name}
								defaultValue={props.query[filter.name] ?? ''}
								style={{ ...styles.input, width: '100%' }}
							>
								<option value="">Any</option>
								{filter.options.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</div>
					))}
					<button type="submit" style={styles.primaryButton}>
						Filter
					</button>
					{queryString ? (
						<Link href={`/${props.path}`} style={{ fontSize: '0.78rem', color: '#6b7280', alignSelf: 'center' }}>
							Clear
						</Link>
					) : null}
				</form>
			) : null}

			{props.rows.length === 0 ? (
				<div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: '10px' }}>
					<EmptyState message={props.emptyMessage} hint={props.emptyHint} />
				</div>
			) : (
				<Table columns={props.columns.map((column) => column.header)}>
					{props.rows.map((row) => (
						<tr key={props.rowKey(row)} style={{ borderBottom: '1px solid #f3f4f6' }}>
							{props.columns.map((column, index) => (
								<td
									key={`${column.header}-${index}`}
									style={{
										padding: '0.6rem 0.85rem',
										fontSize: '0.85rem',
										verticalAlign: 'top',
										textAlign: column.align ?? 'left',
									}}
								>
									{column.render(row)}
								</td>
							))}
						</tr>
					))}
				</Table>
			)}

			{props.totalPages !== null && props.totalPages > 1 ? (
				<div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginTop: '1rem' }}>
					{props.page > 1 ? (
						<Link href={href(props.page - 1)} style={styles.pager}>
							← Previous
						</Link>
					) : null}
					<span style={{ fontSize: '0.8rem', color: '#6b7280' }}>
						Page {props.page} of {props.totalPages}
					</span>
					{props.page < props.totalPages ? (
						<Link href={href(props.page + 1)} style={styles.pager}>
							Next →
						</Link>
					) : null}
				</div>
			) : null}

			{props.actions}
		</div>
	);
}

const styles = {
	input: {
		padding: '0.4rem 0.55rem',
		border: '1px solid #d1d5db',
		borderRadius: '6px',
		fontSize: '0.78rem',
	} as React.CSSProperties,
	label: {
		display: 'block',
		fontSize: '0.68rem',
		fontWeight: 600,
		color: '#6b7280',
		marginBottom: '0.15rem',
		textTransform: 'uppercase',
		letterSpacing: '0.03em',
	} as React.CSSProperties,
	primaryButton: {
		padding: '0.45rem 1rem',
		background: '#1a1a2e',
		color: '#fff',
		border: 'none',
		borderRadius: '6px',
		fontSize: '0.8rem',
		cursor: 'pointer',
	} as React.CSSProperties,
	pager: {
		padding: '0.4rem 0.85rem',
		background: '#fff',
		border: '1px solid #d1d5db',
		borderRadius: '6px',
		fontSize: '0.8rem',
		color: '#2563eb',
		textDecoration: 'none',
	} as React.CSSProperties,
	filterBar: {
		display: 'flex',
		gap: '0.6rem',
		flexWrap: 'wrap',
		marginBottom: '1rem',
		padding: '0.9rem 1rem',
		background: '#fff',
		border: '1px solid #e5e7eb',
		borderRadius: '10px',
		alignItems: 'flex-end',
	} as React.CSSProperties,
};

/** Shared helpers so every page parses its query string the same way. */
export function singleParam(value: string | string[] | undefined): string {
	return typeof value === 'string' ? value : '';
}

export function positiveInt(value: string | string[] | undefined, fallback: number): number {
	const raw = Array.isArray(value) ? value[0] : value;
	const parsed = Number.parseInt(raw ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Truncated monospace id, used consistently so rows are visually comparable. */
export function shortId(value: string | null | undefined, length = 8): string {
	if (!value) return '—';
	return `${value.slice(0, length)}…`;
}
