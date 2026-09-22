/**
 * Admin Control Center — avatar.
 *
 * The avatar is client-rendered: the server stores an enablement flag and, in the
 * database, an inventory of usable assets. Animation state, viseme configuration and
 * TTS/avatar synchronisation are **device-side behaviour** — the server has no lever over
 * them and this page does not pretend otherwise.
 *
 * There is deliberately no animated preview. A live avatar preview would have to reimplement
 * the Flutter renderer in the browser, and a preview that does not match the real renderer
 * is worse than no preview: it would have an operator approve a configuration that does
 * not look like what ships.
 */

import Link from 'next/link';
import { getAvatarConfig, getConfig } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import { Card, Cell, Notes, PageHeader, Row, StatusBadge, Table } from '../../components/ui';

export const dynamic = 'force-dynamic';

function renderValue(value: unknown): string {
	if (value === null || value === undefined) return '—';
	if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

export default async function AvatarPage() {
	const result = await loadPage(async () => {
		const [config, avatar, platformConfig] = await Promise.all([
			loadPage(async () => {
				const data = await getConfig();
				return { rows: [data] };
			}),
			getAvatarConfig().catch(() => null),
			Promise.resolve(null),
		]);
		return { rows: [{ config, avatar, platformConfig }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Avatar" />
				<PageError
					title="Could not load avatar configuration"
					message={result.message}
					status={result.status}
					retryHref="/avatar"
				/>
			</div>
		);
	}

	const payload = result.rows[0];
	const avatar = payload?.avatar ?? {};
	const configEntries = payload?.config?.ok ? payload.config.rows[0].entries : [];
	const avatarKeys = configEntries.filter((entry) => entry.key.startsWith('AVATAR'));

	const settings = Object.entries(avatar).filter(([key]) => !['notes', 'limitations'].includes(key));

	return (
		<div>
			<PageHeader
				title="Avatar"
				subtitle="Enablement and asset inventory. Animation and viseme behaviour is rendered on the device."
				actions={
					<Link href="/configuration" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						Configuration →
					</Link>
				}
			/>

			<Notes
				notes={[
					'There is no live preview. The avatar renders in Flutter; a browser preview would be a second implementation, and one that disagreed with the app would be worse than none.',
					'Animation states (idle, listening, thinking, speaking), visemes and TTS synchronisation are device-side. The server cannot change them, so this page does not offer controls that would do nothing.',
				]}
				tone="warn"
			/>

			<Card title="Enablement" subtitle="Keys the runtime actually reads">
				{avatarKeys.length === 0 ? (
					<Notes notes={['No avatar configuration key was found in the catalog.']} tone="warn" />
				) : (
					<Table columns={['Key', 'Value', 'Source', 'Read by runtime', 'Notes']}>
						{avatarKeys.map((entry) => (
							<Row key={entry.key}>
								<Cell mono>{entry.key}</Cell>
								<Cell>
									{entry.value === null ? <span style={{ color: '#dc2626' }}>unset</span> : entry.value}
								</Cell>
								<Cell muted>{entry.effectiveSource}</Cell>
								<Cell>
									<StatusBadge
										status={entry.readByRuntime ? 'pass' : 'unknown'}
										label={entry.readByRuntime ? 'live' : 'not wired'}
									/>
								</Cell>
								<Cell muted>
									<div style={{ maxWidth: '380px', fontSize: '0.75rem' }}>{entry.runtimeWiringNote}</div>
								</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card title="Asset inventory" subtitle="As reported by the API">
				{settings.length === 0 ? (
					<Notes notes={['The API returned no avatar details.']} tone="warn" />
				) : (
					<Table columns={['Aspect', 'Value']}>
						{settings.map(([key, value]) => (
							<Row key={key}>
								<Cell mono>{key}</Cell>
								<Cell>{renderValue(value)}</Cell>
							</Row>
						))}
					</Table>
				)}
			</Card>

			<Card title="Device-side behaviour (not controllable here)" subtitle="Recorded so the operator knows where to look">
				<Table columns={['Behaviour', 'Where it lives', 'Server control']}>
					<Row>
						<Cell>Animation states</Cell>
						<Cell mono>apps/mobile/lib/core/avatar/avatar_provider.dart</Cell>
						<Cell>
							<StatusBadge status="not_configured" label="none" />
						</Cell>
					</Row>
					<Row>
						<Cell>Appearance (emotion, density)</Cell>
						<Cell>Stored per user in `avatars`; set by the user from the app</Cell>
						<Cell>
							<StatusBadge status="unknown" label="read-only here" />
						</Cell>
					</Row>
					<Row>
						<Cell>Visemes / lip sync</Cell>
						<Cell>Not implemented in the client</Cell>
						<Cell>
							<StatusBadge status="not_configured" label="none" />
						</Cell>
					</Row>
					<Row>
						<Cell>Overlay orb</Cell>
						<Cell mono>apps/mobile/lib/app/shell.dart</Cell>
						<Cell>
							<StatusBadge status="unknown" label="flag only" />
						</Cell>
					</Row>
				</Table>
				<p style={{ fontSize: '0.75rem', color: '#6b7280', margin: '0.75rem 0 0', lineHeight: 1.6 }}>
					The &ldquo;overlay&rdquo; in NOVA is an in-app orb, not an Android system overlay. A release build does
					not hold `SYSTEM_ALERT_WINDOW`, so the `OVERLAY` flag gates an in-app surface rather than a floating
					window over other apps.
				</p>
			</Card>
		</div>
	);
}
