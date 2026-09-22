/**
 * Admin Control Center — maintenance mode and emergency safeguards.
 *
 * This is the page an operator opens when something is actively wrong. It is therefore
 * built around consequences rather than labels: every switch states what stops working
 * for a real user when it is thrown, and each disable action needs a reason plus a
 * typed confirmation, because an emergency control that can be toggled by a stray click
 * is worse than no control at all.
 *
 * The database is the source of truth for these states (`system_configs` under the
 * `CONTROL_*` keys), not this page. Reload and the switches reflect what the server is
 * actually doing.
 */

import Link from 'next/link';
import { getControls, getEnvironment, type ControlDefinition, type RuntimeControls } from '../../lib/api';
import { loadPage } from '../../lib/page-data';
import { PageError } from '../../components/PageError';
import { Card, Notes, PageHeader, StatusBadge, formatDateTime } from '../../components/ui';
import { setControlAction, setMaintenanceAction } from './actions';

export const dynamic = 'force-dynamic';

const inputStyle: React.CSSProperties = {
	width: '100%',
	padding: '0.45rem 0.6rem',
	border: '1px solid #d1d5db',
	borderRadius: '6px',
	fontSize: '0.82rem',
};

const labelStyle: React.CSSProperties = {
	display: 'block',
	fontSize: '0.68rem',
	fontWeight: 600,
	color: '#6b7280',
	marginBottom: '0.15rem',
	textTransform: 'uppercase',
	letterSpacing: '0.03em',
};

/**
 * What actually happens when each capability is off.
 *
 * Written per control rather than generated from the key name: "Voice is off" is not
 * an impact assessment, and an operator mid-incident needs to know whether chat still
 * works and whether money is still being spent.
 */
const CONSEQUENCES: Record<string, { whenOff: string; whenOn: string }> = {
	CONTROL_AI_ENABLED: {
		whenOff: 'No LLM call is attempted. Chat, voice replies and summarisation all fail. No tokens are billed.',
		whenOn: 'Chat and voice replies work normally and provider usage is billed.',
	},
	CONTROL_VOICE_ENABLED: {
		whenOff: 'New realtime voice sockets are refused with 503. Typed chat still works.',
		whenOn: 'Users can start voice conversations.',
	},
	CONTROL_STT_ENABLED: {
		whenOff: 'Voice sessions refuse audio with a transcription-unavailable error. Typed chat still works.',
		whenOn: 'Speech is transcribed by the configured provider.',
	},
	CONTROL_TTS_ENABLED: {
		whenOff: 'NOVA replies with text only. The app falls back to on-device speech synthesis.',
		whenOn: 'NOVA speaks with the configured provider voice.',
	},
	CONTROL_BACKGROUND_JOBS_ENABLED: {
		whenOff: 'The follow-up engine, retention sweep and recording reaper skip their runs. Reminders already armed on devices still fire.',
		whenOn: 'Scheduled engines run on their intervals.',
	},
	CONTROL_PROACTIVE_ENABLED: {
		whenOff: 'NOVA never initiates contact, whatever any feature flag says.',
		whenOn: 'NOVA may reach out unprompted (follow-ups, nudges) subject to feature flags.',
	},
	CONTROL_NOTIFICATIONS_ENABLED: {
		whenOff: 'Outbound notifications are suppressed. Reminder alerts already scheduled on the device are unaffected.',
		whenOn: 'Notifications are created and delivered.',
	},
	CONTROL_REALTIME_ENABLED: {
		whenOff: 'The WebSocket gateway refuses new connections. Voice is effectively unavailable.',
		whenOn: 'Realtime voice sockets are accepted.',
	},
};

function controlValue(controls: RuntimeControls, key: string): boolean | string | undefined {
	const map: Record<string, keyof RuntimeControls> = {
		CONTROL_AI_ENABLED: 'aiEnabled',
		CONTROL_VOICE_ENABLED: 'voiceEnabled',
		CONTROL_STT_ENABLED: 'sttEnabled',
		CONTROL_TTS_ENABLED: 'ttsEnabled',
		CONTROL_BACKGROUND_JOBS_ENABLED: 'backgroundJobsEnabled',
		CONTROL_PROACTIVE_ENABLED: 'proactiveEnabled',
		CONTROL_NOTIFICATIONS_ENABLED: 'notificationsEnabled',
		CONTROL_REALTIME_ENABLED: 'realtimeEnabled',
		CONTROL_MAINTENANCE_MODE: 'maintenanceMode',
		CONTROL_MAINTENANCE_MESSAGE: 'maintenanceMessage',
		CONTROL_OPERATOR_NOTE: 'operatorNote',
	};
	const property = map[key];
	if (!property) return undefined;
	const value = controls[property];
	return typeof value === 'boolean' || typeof value === 'string' ? value : undefined;
}

export default async function MaintenancePage({
	searchParams,
}: {
	searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
	const resolved = await searchParams;
	const errorMessage = typeof resolved.error === 'string' ? resolved.error : '';
	const okMessage = typeof resolved.ok === 'string' ? resolved.ok : '';

	const result = await loadPage<{
		controls: RuntimeControls;
		definitions: ControlDefinition[];
		environment: Awaited<ReturnType<typeof getEnvironment>> | null;
	}>(async () => {
		const [{ controls, definitions }, environment] = await Promise.all([
			getControls(),
			getEnvironment().catch(() => null),
		]);
		return { rows: [{ controls, definitions, environment }] };
	});

	if (!result.ok) {
		return (
			<div>
				<PageHeader title="Maintenance & Safeguards" />
				<PageError
					title="Could not load controls"
					message={result.message}
					status={result.status}
					retryHref="/maintenance"
				/>
			</div>
		);
	}

	const { controls, definitions, environment } = result.rows[0] ?? {
		controls: null as unknown as RuntimeControls,
		definitions: [] as ControlDefinition[],
		environment: null,
	};

	const capabilityDefinitions = definitions.filter((definition) => definition.scope === 'capability');
	const metadataDefinitions = definitions.filter((definition) => definition.scope === 'metadata');
	const isProduction = environment?.nodeEnv === 'production' || environment?.environment === 'production';

	return (
		<div>
			<PageHeader
				title="Maintenance & Safeguards"
				subtitle={
					<>
						Emergency controls read on every affected request.{' '}
						{controls.anyDisabled ? (
							<strong style={{ color: '#dc2626' }}>Something is currently switched off.</strong>
						) : (
							<span style={{ color: '#059669' }}>All capabilities are operating normally.</span>
						)}
					</>
				}
				actions={
					<Link href="/" style={{ fontSize: '0.8rem', color: '#2563eb' }}>
						← Dashboard
					</Link>
				}
			/>

			{isProduction ? (
				<Notes
					tone="warn"
					notes={[
						'This console is talking to a PRODUCTION environment. Every change on this page affects real users immediately (within the control cache window of 5 seconds).',
					]}
				/>
			) : null}

			{errorMessage ? (
				<div role="alert" style={alert('#fef2f2', '#fecaca', '#7f1d1d')}>
					{errorMessage}
				</div>
			) : null}
			{okMessage ? (
				<div role="status" style={alert('#ecfdf5', '#a7f3d0', '#065f46')}>
					{okMessage}
				</div>
			) : null}

			<Card
				title={
					<span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
						Global maintenance mode
						<StatusBadge status={controls.maintenanceMode ? 'fail' : 'pass'} label={controls.maintenanceMode ? 'ACTIVE' : 'off'} />
					</span>
				}
				subtitle="When on: clients are told NOVA is unavailable, AI and voice requests are refused with 503, and existing sessions are left intact. Turning it off restores service immediately."
			>
				{controls.maintenanceMode ? (
					<div
						style={{
							background: '#fef2f2',
							border: '1px solid #fecaca',
							borderRadius: '8px',
							padding: '0.75rem 1rem',
							marginBottom: '0.9rem',
							fontSize: '0.82rem',
							color: '#7f1d1d',
						}}
					>
						Users currently see: “{controls.maintenanceMessage}”
					</div>
				) : null}

				<div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
					<form action={setMaintenanceAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: '2 1 340px' }}>
						<input type="hidden" name="enabled" value="true" />
						<div>
							<label style={labelStyle} htmlFor="mt-message">
								Message shown to users
							</label>
							<textarea
								id="mt-message"
								name="message"
								rows={2}
								defaultValue={controls.maintenanceMessage}
								style={inputStyle}
								placeholder="NOVA is briefly unavailable while we perform scheduled maintenance."
							/>
						</div>
						<div>
							<label style={labelStyle} htmlFor="mt-note">
								Operator note (shown on the dashboard so the next operator knows why)
							</label>
							<input id="mt-note" name="note" defaultValue={controls.operatorNote} style={inputStyle} />
						</div>
						<div style={{ display: 'flex', gap: '0.5rem' }}>
							<div style={{ flex: 1 }}>
								<label style={labelStyle} htmlFor="mt-reason">
									Reason (audited)
								</label>
								<input id="mt-reason" name="reason" required style={inputStyle} />
							</div>
							<div style={{ flex: 1 }}>
								<label style={labelStyle} htmlFor="mt-confirm">
									Type MAINTENANCE to confirm
								</label>
								<input id="mt-confirm" name="confirm" placeholder="MAINTENANCE" style={inputStyle} />
							</div>
						</div>
						<button type="submit" style={dangerButton}>
							{controls.maintenanceMode ? 'Update maintenance notice' : 'Take NOVA into maintenance'}
						</button>
					</form>

					{controls.maintenanceMode ? (
						<form action={setMaintenanceAction} style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: '1 1 240px' }}>
							<input type="hidden" name="enabled" value="false" />
							<input type="hidden" name="note" value={controls.operatorNote} />
							<div>
								<label style={labelStyle} htmlFor="mt-off-reason">
									Reason for ending maintenance
								</label>
								<input id="mt-off-reason" name="reason" required style={inputStyle} />
							</div>
							<button type="submit" style={restoreButton}>
								End maintenance and restore service
							</button>
						</form>
					) : null}
				</div>
			</Card>

			<h2 style={sectionHeading}>Capability kill switches</h2>
			<Notes
				tone="warn"
				notes={[
					'These are emergency controls, not feature flags. A feature flag decides WHO gets a feature; a kill switch decides whether the capability runs at all for anyone.',
					'Disabling one requires a reason and typing DISABLE. Re-enabling does not, because restoring service should never be impeded.',
				]}
			/>

			{capabilityDefinitions.map((definition) => {
				const current = controlValue(controls, definition.key);
				const enabled = current !== false;
				const consequence = CONSEQUENCES[definition.key];

				return (
					<Card
						key={definition.key}
						title={
							<span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
								{definition.label}
								<StatusBadge status={enabled ? 'pass' : 'fail'} label={enabled ? 'operating' : 'DISABLED'} />
							</span>
						}
						subtitle={definition.description}
					>
						<p style={{ fontSize: '0.82rem', color: enabled ? '#374151' : '#991b1b', margin: '0 0 0.75rem' }}>
							{enabled ? (consequence?.whenOn ?? 'Operating normally.') : `Currently: ${consequence?.whenOff ?? 'Disabled.'}`}
						</p>
						{enabled ? (
							<form action={setControlAction} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
								<input type="hidden" name="key" value={definition.key} />
								<input type="hidden" name="value" value="false" />
								<div style={{ flex: '1 1 240px' }}>
									<label style={labelStyle} htmlFor={`reason-${definition.key}`}>
										Reason (audited)
									</label>
									<input id={`reason-${definition.key}`} name="reason" required style={inputStyle} />
								</div>
								<div style={{ flex: '0 1 170px' }}>
									<label style={labelStyle} htmlFor={`confirm-${definition.key}`}>
										Type DISABLE
									</label>
									<input id={`confirm-${definition.key}`} name="confirm" placeholder="DISABLE" style={inputStyle} />
								</div>
								<button type="submit" style={dangerButton}>
									Disable {definition.label}
								</button>
							</form>
						) : (
							<form action={setControlAction} style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
								<input type="hidden" name="key" value={definition.key} />
								<input type="hidden" name="value" value="true" />
								<div style={{ flex: '1 1 240px' }}>
									<label style={labelStyle} htmlFor={`reason-on-${definition.key}`}>
										Reason for restoring (audited)
									</label>
									<input id={`reason-on-${definition.key}`} name="reason" required style={inputStyle} />
								</div>
								<button type="submit" style={restoreButton}>
									Re-enable {definition.label}
								</button>
							</form>
						)}
					</Card>
				);
			})}

			<Card
				title="Operator note"
				subtitle="Free text shown on the dashboard banner, so the next person on shift knows why the controls are in this state."
			>
				<form action={setControlAction} style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
					<input type="hidden" name="key" value="CONTROL_OPERATOR_NOTE" />
					<div style={{ flex: '2 1 320px' }}>
						<label style={labelStyle} htmlFor="op-note">
							Note
						</label>
						<input id="op-note" name="value" defaultValue={controls.operatorNote} style={inputStyle} />
					</div>
					<div style={{ flex: '1 1 200px' }}>
						<label style={labelStyle} htmlFor="op-note-reason">
							Reason
						</label>
						<input id="op-note-reason" name="reason" required style={inputStyle} />
					</div>
					<button type="submit" style={restoreButton}>
						Save note
					</button>
				</form>
				{metadataDefinitions.length === 0 ? (
					<p style={{ fontSize: '0.72rem', color: '#9ca3af', margin: '0.5rem 0 0' }}>
						No metadata controls are declared by the API.
					</p>
				) : null}
			</Card>

			<Notes
				notes={[
					'A control change is visible to this API process within 5 seconds and to other replicas on their next read of the same cache.',
					`Current environment: ${environment?.environment ?? 'unknown'} (NODE_ENV=${environment?.nodeEnv ?? 'unknown'}). Service uptime ${environment ? Math.floor(environment.self.uptimeSeconds / 60) : '—'} minutes as of ${formatDateTime(new Date().toISOString())}.`,
					'There is no automatic rollback: a kill switch stays where an operator put it until another operator changes it. Each change is recorded in the audit log with its reason.',
				]}
			/>
		</div>
	);
}

const sectionHeading: React.CSSProperties = {
	fontSize: '0.78rem',
	fontWeight: 700,
	textTransform: 'uppercase',
	letterSpacing: '0.06em',
	color: '#6b7280',
	margin: '1.5rem 0 0.6rem',
};

const dangerButton: React.CSSProperties = {
	padding: '0.5rem 1rem',
	background: '#dc2626',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	fontWeight: 600,
	cursor: 'pointer',
	whiteSpace: 'nowrap',
};

const restoreButton: React.CSSProperties = {
	padding: '0.5rem 1rem',
	background: '#059669',
	color: '#fff',
	border: 'none',
	borderRadius: '6px',
	fontSize: '0.8rem',
	fontWeight: 600,
	cursor: 'pointer',
	whiteSpace: 'nowrap',
};

function alert(background: string, border: string, color: string): React.CSSProperties {
	return {
		marginBottom: '1rem',
		padding: '0.75rem 1rem',
		background,
		border: `1px solid ${border}`,
		borderRadius: '8px',
		color,
		fontSize: '0.85rem',
		lineHeight: 1.5,
	};
}
