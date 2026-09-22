/**
 * Admin console — shared presentational components.
 *
 * Small, dependency-free, inline-styled to match the console's existing pages. The
 * important one is [Metric], which renders the three states a number can be in:
 *
 *   - a value
 *   - a value with a caveat sentence attached
 *   - **not available**, with the reason and what would make it available
 *
 * That third state is the whole point. A control panel that prints `0` for a metric it
 * cannot compute is lying in a way the operator cannot detect, and "no device has ever
 * registered" reads identically to "no devices are online right now". Every metric card
 * therefore carries its own provenance.
 */

import type { ReactNode } from 'react';

export type MetricAvailability = {
	value: number | null;
	caveat: string | null;
	unavailableReason: string | null;
	instrumentationNeeded: string | null;
};

const COLORS = {
	border: '#e5e7eb',
	muted: '#6b7280',
	subtle: '#9ca3af',
	text: '#111827',
	surface: '#ffffff',
	background: '#f9fafb',
	pass: '#059669',
	warn: '#d97706',
	fail: '#dc2626',
	info: '#2563eb',
	passBg: '#ecfdf5',
	warnBg: '#fffbeb',
	failBg: '#fef2f2',
	infoBg: '#eff6ff',
} as const;

export function formatNumber(value: number | null | undefined): string {
	if (value === null || value === undefined) return '—';
	return value.toLocaleString('en-IN');
}

export function formatUsd(value: number | null | undefined, digits = 4): string {
	if (value === null || value === undefined) return '—';
	return `$${value.toFixed(digits)}`;
}

export function formatBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(1)} ${units[unit]}`;
}

export function formatDateTime(value: string | null | undefined): string {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	return date.toLocaleString('en-IN', {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	});
}

export function formatRelative(value: string | null | undefined): string {
	if (!value) return '—';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return '—';
	const seconds = Math.round((Date.now() - date.getTime()) / 1000);
	const abs = Math.abs(seconds);
	const suffix = seconds >= 0 ? 'ago' : 'from now';
	if (abs < 60) return `${abs}s ${suffix}`;
	if (abs < 3600) return `${Math.round(abs / 60)}m ${suffix}`;
	if (abs < 86400) return `${Math.round(abs / 3600)}h ${suffix}`;
	return `${Math.round(abs / 86400)}d ${suffix}`;
}

export function formatDuration(ms: number | null | undefined): string {
	if (ms === null || ms === undefined) return '—';
	if (ms < 1000) return `${ms} ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)} s`;
	const minutes = seconds / 60;
	if (minutes < 60) return `${minutes.toFixed(1)} min`;
	return `${(minutes / 60).toFixed(1)} h`;
}

export function Card({
	title,
	subtitle,
	action,
	children,
	padding = '1.25rem',
}: {
	title?: ReactNode;
	subtitle?: ReactNode;
	action?: ReactNode;
	children: ReactNode;
	padding?: string;
}) {
	return (
		<section
			style={{
				background: COLORS.surface,
				border: `1px solid ${COLORS.border}`,
				borderRadius: '10px',
				padding,
				marginBottom: '1rem',
			}}
		>
			{title || action ? (
				<div
					style={{
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'flex-start',
						gap: '1rem',
						marginBottom: '0.75rem',
					}}
				>
					<div>
						{title ? (
							<h2 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: COLORS.text }}>{title}</h2>
						) : null}
						{subtitle ? (
							<p style={{ margin: '0.25rem 0 0', fontSize: '0.8rem', color: COLORS.muted }}>{subtitle}</p>
						) : null}
					</div>
					{action}
				</div>
			) : null}
			{children}
		</section>
	);
}

/**
 * A metric tile that can say "I do not know".
 *
 * [metric] is preferred for anything derived from analytics; [value] is for simple,
 * always-computable counts.
 */
export function Metric({
	label,
	value,
	metric,
	hint,
	tone = 'default',
}: {
	label: string;
	value?: number | string | null;
	metric?: MetricAvailability;
	hint?: ReactNode;
	tone?: 'default' | 'good' | 'warn' | 'bad';
}) {
	const isAvailable = metric ? metric.value !== null : value !== null && value !== undefined;
	const displayed = metric
		? metric.value === null
			? 'NOT AVAILABLE'
			: formatNumber(metric.value)
		: typeof value === 'number'
			? formatNumber(value)
			: (value ?? '—');

	const toneColor =
		tone === 'good' ? COLORS.pass : tone === 'warn' ? COLORS.warn : tone === 'bad' ? COLORS.fail : COLORS.text;

	return (
		<div
			style={{
				background: COLORS.surface,
				border: `1px solid ${COLORS.border}`,
				borderRadius: '10px',
				padding: '1rem',
				display: 'flex',
				flexDirection: 'column',
				gap: '0.25rem',
				minWidth: 0,
			}}
		>
			<span
				style={{
					fontSize: '0.72rem',
					fontWeight: 600,
					textTransform: 'uppercase',
					letterSpacing: '0.03em',
					color: COLORS.muted,
				}}
			>
				{label}
			</span>
			<span
				style={{
					fontSize: isAvailable ? '1.5rem' : '0.85rem',
					fontWeight: 700,
					color: isAvailable ? toneColor : COLORS.subtle,
					fontVariantNumeric: 'tabular-nums',
				}}
			>
				{displayed}
			</span>
			{hint ? <span style={{ fontSize: '0.75rem', color: COLORS.muted }}>{hint}</span> : null}
			{metric?.caveat ? (
				<span style={{ fontSize: '0.72rem', color: COLORS.warn, lineHeight: 1.4 }}>⚠ {metric.caveat}</span>
			) : null}
			{metric && metric.value === null && metric.unavailableReason ? (
				<span style={{ fontSize: '0.72rem', color: COLORS.subtle, lineHeight: 1.4 }}>
					{metric.unavailableReason}
					{metric.instrumentationNeeded ? (
						<>
							<br />
							<em>To fix: {metric.instrumentationNeeded}</em>
						</>
					) : null}
				</span>
			) : null}
		</div>
	);
}

export function MetricGrid({ children, minWidth = 200 }: { children: ReactNode; minWidth?: number }) {
	return (
		<div
			style={{
				display: 'grid',
				gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`,
				gap: '0.75rem',
				marginBottom: '1rem',
			}}
		>
			{children}
		</div>
	);
}

const STATUS_TONES: Record<string, { bg: string; fg: string; border: string }> = {
	// Health / provider states
	pass: { bg: COLORS.passBg, fg: COLORS.pass, border: '#a7f3d0' },
	healthy: { bg: COLORS.passBg, fg: COLORS.pass, border: '#a7f3d0' },
	active: { bg: COLORS.passBg, fg: COLORS.pass, border: '#a7f3d0' },
	succeeded: { bg: COLORS.passBg, fg: COLORS.pass, border: '#a7f3d0' },
	completed: { bg: COLORS.passBg, fg: COLORS.pass, border: '#a7f3d0' },
	degraded: { bg: COLORS.warnBg, fg: COLORS.warn, border: '#fde68a' },
	// A recorded test that describes a credential which has since been replaced. Warn rather than
	// neutral: nothing is known to be broken, but nothing is known to work either, and the fallback
	// grey would let it read as "fine".
	stale: { bg: COLORS.warnBg, fg: COLORS.warn, border: '#fde68a' },
	warning: { bg: COLORS.warnBg, fg: COLORS.warn, border: '#fde68a' },
	pending: { bg: COLORS.warnBg, fg: COLORS.warn, border: '#fde68a' },
	running: { bg: COLORS.infoBg, fg: COLORS.info, border: '#bfdbfe' },
	overdue: { bg: COLORS.failBg, fg: COLORS.fail, border: '#fecaca' },
	// A reminder the user opened. Distinct from `active` on purpose: `active` means
	// "nothing is wrong yet", `acknowledged` means "a human engaged with it", and only
	// the second is evidence anything was delivered.
	acknowledged: { bg: COLORS.infoBg, fg: COLORS.info, border: '#bfdbfe' },
	fail: { bg: COLORS.failBg, fg: COLORS.fail, border: '#fecaca' },
	down: { bg: COLORS.failBg, fg: COLORS.fail, border: '#fecaca' },
	failed: { bg: COLORS.failBg, fg: COLORS.fail, border: '#fecaca' },
	disabled: { bg: COLORS.failBg, fg: COLORS.fail, border: '#fecaca' },
	denied: { bg: COLORS.failBg, fg: COLORS.fail, border: '#fecaca' },
	dead_letter: { bg: COLORS.failBg, fg: COLORS.fail, border: '#fecaca' },
	unknown: { bg: COLORS.background, fg: COLORS.muted, border: COLORS.border },
	not_configured: { bg: COLORS.background, fg: COLORS.muted, border: COLORS.border },
	dismissed: { bg: COLORS.background, fg: COLORS.muted, border: COLORS.border },
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
	const tone = STATUS_TONES[status] ?? STATUS_TONES.unknown;
	return (
		<span
			style={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: '0.3rem',
				padding: '0.15rem 0.5rem',
				borderRadius: '9999px',
				fontSize: '0.72rem',
				fontWeight: 600,
				background: tone.bg,
				color: tone.fg,
				border: `1px solid ${tone.border}`,
				whiteSpace: 'nowrap',
			}}
		>
			{(label ?? status).replace(/_/g, ' ')}
		</span>
	);
}

export function Table({ columns, children }: { columns: string[]; children: ReactNode }) {
	return (
		<div style={{ overflowX: 'auto', border: `1px solid ${COLORS.border}`, borderRadius: '10px' }}>
			<table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
				<thead>
					<tr style={{ background: COLORS.background, borderBottom: `1px solid ${COLORS.border}` }}>
						{columns.map((column) => (
							<th
								key={column}
								style={{
									textAlign: 'left',
									padding: '0.6rem 0.85rem',
									fontWeight: 600,
									color: COLORS.muted,
									fontSize: '0.72rem',
									textTransform: 'uppercase',
									letterSpacing: '0.03em',
									whiteSpace: 'nowrap',
								}}
							>
								{column}
							</th>
						))}
					</tr>
				</thead>
				<tbody>{children}</tbody>
			</table>
		</div>
	);
}

export function Row({ children }: { children: ReactNode }) {
	return <tr style={{ borderBottom: `1px solid #f3f4f6` }}>{children}</tr>;
}

export function Cell({
	children,
	muted = false,
	mono = false,
	align = 'left',
}: {
	children: ReactNode;
	muted?: boolean;
	mono?: boolean;
	align?: 'left' | 'right' | 'center';
}) {
	return (
		<td
			style={{
				padding: '0.6rem 0.85rem',
				color: muted ? COLORS.muted : COLORS.text,
				fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
				textAlign: align,
				fontSize: mono ? '0.8rem' : undefined,
				verticalAlign: 'top',
			}}
		>
			{children}
		</td>
	);
}

export function EmptyState({ message, hint }: { message: string; hint?: string }) {
	return (
		<div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: COLORS.subtle }}>
			<p style={{ margin: 0, fontSize: '0.9rem' }}>{message}</p>
			{hint ? <p style={{ margin: '0.35rem 0 0', fontSize: '0.78rem' }}>{hint}</p> : null}
		</div>
	);
}

/** A block of explanatory text, used for the honest limitations each page carries. */
export function Notes({ notes, tone = 'info' }: { notes: (string | null | undefined)[]; tone?: 'info' | 'warn' }) {
	const filtered = notes.filter((note): note is string => Boolean(note));
	if (filtered.length === 0) return null;

	const palette =
		tone === 'warn'
			? { bg: COLORS.warnBg, border: '#fde68a', fg: '#92400e' }
			: { bg: COLORS.infoBg, border: '#bfdbfe', fg: '#1e40af' };

	return (
		<div
			style={{
				background: palette.bg,
				border: `1px solid ${palette.border}`,
				borderRadius: '8px',
				padding: '0.75rem 1rem',
				marginBottom: '1rem',
				color: palette.fg,
				fontSize: '0.8rem',
				lineHeight: 1.5,
			}}
		>
			<ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
				{filtered.map((note) => (
					<li key={note}>{note}</li>
				))}
			</ul>
		</div>
	);
}

export function PageHeader({
	title,
	subtitle,
	actions,
}: {
	title: string;
	subtitle?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<div
			style={{
				display: 'flex',
				justifyContent: 'space-between',
				alignItems: 'flex-start',
				gap: '1rem',
				marginBottom: '1.25rem',
				flexWrap: 'wrap',
			}}
		>
			<div>
				<h1 style={{ margin: 0, fontSize: '1.6rem', fontWeight: 700, color: COLORS.text }}>{title}</h1>
				{subtitle ? (
					<div style={{ margin: '0.3rem 0 0', fontSize: '0.85rem', color: COLORS.muted }}>{subtitle}</div>
				) : null}
			</div>
			{actions ? <div style={{ display: 'flex', gap: '0.5rem' }}>{actions}</div> : null}
		</div>
	);
}

export const TONES = COLORS;
