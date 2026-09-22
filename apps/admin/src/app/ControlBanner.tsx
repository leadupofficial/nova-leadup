/**
 * Operator-state banner.
 *
 * Shown at the top of the dashboard whenever an emergency control or maintenance mode
 * is active. The point is that an operator arriving during an incident sees *that
 * something is switched off* and *why*, before they start reading metrics — the
 * failure mode being guarded against is someone spending ten minutes debugging a
 * symptom that a colleague deliberately caused.
 */

import Link from 'next/link';
import type { RuntimeControls } from '../lib/api';

const DISABLED_LABELS: Array<{ key: keyof RuntimeControls; label: string; consequence: string }> = [
	{ key: 'aiEnabled', label: 'AI', consequence: 'All chat and AI replies are refused with 503.' },
	{ key: 'voiceEnabled', label: 'Voice', consequence: 'New realtime voice sessions are refused.' },
	{ key: 'sttEnabled', label: 'Speech-to-text', consequence: 'Voice sessions reject audio.' },
	{ key: 'ttsEnabled', label: 'Text-to-speech', consequence: 'Replies are text-only; the client falls back to on-device speech.' },
	{ key: 'backgroundJobsEnabled', label: 'Background jobs', consequence: 'Follow-up, retention and reaper sweeps skip their runs.' },
	{ key: 'proactiveEnabled', label: 'Proactive assistant', consequence: 'NOVA never initiates contact.' },
	{ key: 'notificationsEnabled', label: 'Notifications', consequence: 'Outbound notifications are suppressed.' },
	{ key: 'realtimeEnabled', label: 'Realtime transport', consequence: 'WebSocket connections are refused.' },
];

export function ControlBanner({ controls }: { controls: RuntimeControls }) {
	if (!controls.anyDisabled) {
		return null;
	}

	const disabled = DISABLED_LABELS.filter((entry) => controls[entry.key] === false);

	return (
		<div
			role="status"
			style={{
				background: controls.maintenanceMode ? '#fef2f2' : '#fffbeb',
				border: `1px solid ${controls.maintenanceMode ? '#fecaca' : '#fde68a'}`,
				borderRadius: '10px',
				padding: '1rem 1.15rem',
				marginBottom: '1.25rem',
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}>
				<span aria-hidden style={{ fontSize: '1.1rem' }}>
					{controls.maintenanceMode ? '⛔' : '⚠️'}
				</span>
				<strong style={{ color: controls.maintenanceMode ? '#991b1b' : '#92400e', fontSize: '0.9rem' }}>
					{controls.maintenanceMode ? 'Maintenance mode is ACTIVE' : 'Emergency controls are active'}
				</strong>
				<Link
					href="/maintenance"
					style={{ marginLeft: 'auto', fontSize: '0.78rem', color: '#2563eb' }}
				>
					Manage controls →
				</Link>
			</div>

			{controls.maintenanceMode ? (
				<p style={{ margin: '0 0 0.5rem', fontSize: '0.82rem', color: '#7f1d1d' }}>
					Users see: “{controls.maintenanceMessage}”
				</p>
			) : null}

			{disabled.length > 0 ? (
				<ul style={{ margin: 0, paddingLeft: '1.1rem', fontSize: '0.8rem', color: '#92400e', lineHeight: 1.6 }}>
					{disabled.map((entry) => (
						<li key={String(entry.key)}>
							<strong>{entry.label}</strong> is off — {entry.consequence}
						</li>
					))}
				</ul>
			) : null}

			{controls.operatorNote ? (
				<p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: '#6b7280', fontStyle: 'italic' }}>
					Operator note: {controls.operatorNote}
				</p>
			) : null}
		</div>
	);
}
