/**
 * LEA-021 — Admin Languages page.
 *
 * Displays all 22 Indian languages (plus English) supported by NOVA,
 * along with each language's STT and TTS provider routing. Data is
 * sourced from @nova/shared-types so this view never drifts from the
 * client/server runtime definitions.
 */

import {
	SUPPORTED_LANGUAGES,
	MixedLanguageCode,
} from '@nova/shared-types';

const MIXED_LANGUAGES: { code: MixedLanguageCode; label: string }[] = [
	{ code: 'hinglish' as MixedLanguageCode, label: 'Hinglish (Hindi-English)' },
	{ code: 'tanglish' as MixedLanguageCode, label: 'Tanglish (Tamil-English)' },
	{ code: 'benglish' as MixedLanguageCode, label: 'Benglish (Bengali-English)' },
	{ code: 'gujlish' as MixedLanguageCode, label: 'Gujlish (Gujarati-English)' },
];

const providerColor = (provider: string): { bg: string; fg: string; border: string } => {
	switch (provider) {
		case 'sarvam':
			return { bg: '#fef3c7', fg: '#92400e', border: '#fde68a' };
		case 'google':
			return { bg: '#dbeafe', fg: '#1e40af', border: '#bfdbfe' };
		case 'elevenlabs':
			return { bg: '#f3e8ff', fg: '#6b21a8', border: '#e9d5ff' };
		case 'deepgram':
			return { bg: '#dcfce7', fg: '#166534', border: '#bbf7d0' };
		default:
			return { bg: '#f3f4f6', fg: '#374151', border: '#e5e7eb' };
	}
};

export default function LanguagesPage() {
	const indianCount = SUPPORTED_LANGUAGES.filter((l: any) => l.code !== 'en').length;
	const sarvamCount = SUPPORTED_LANGUAGES.filter((l: any) => l.voiceProvider === 'sarvam').length;
	const googleCount = SUPPORTED_LANGUAGES.filter((l: any) => l.voiceProvider === 'google').length;
	const englishCount = SUPPORTED_LANGUAGES.filter((l: any) => l.code === 'en').length;

	return (
		<div>
			<div
				style={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					marginBottom: '1.5rem',
				}}
			>
				<div>
					<h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: 700 }}>Supported Languages</h1>
					<p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#6b7280' }}>
						{SUPPORTED_LANGUAGES.length} languages ({indianCount} Indian + {englishCount} English) ·
						{' '}{MIXED_LANGUAGES.length} mixed-language detectors
					</p>
				</div>
			</div>

			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
					gap: '0.75rem',
					marginBottom: '1.5rem',
				}}
			>
				<SummaryTile label="Sarvam (Indian)" value={sarvamCount} accent="#92400e" />
				<SummaryTile label="Google (long-tail)" value={googleCount} accent="#1e40af" />
				<SummaryTile label="ElevenLabs (English)" value={englishCount} accent="#6b21a8" />
				<SummaryTile label="Mixed-language" value={MIXED_LANGUAGES.length} accent="#166534" />
			</div>

			<div
				style={{
					background: '#fff',
					borderRadius: '8px',
					border: '1px solid #e5e7eb',
					overflow: 'hidden',
				}}
			>
				<table
					style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}
				>
					<thead>
						<tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
							<th style={thStyle}>Code</th>
							<th style={thStyle}>Language</th>
							<th style={thStyle}>Native</th>
							<th style={{ ...thStyle, textAlign: 'center' }}>TTS Provider</th>
							<th style={{ ...thStyle, textAlign: 'center' }}>STT Provider</th>
							<th style={{ ...thStyle, textAlign: 'center' }}>Enabled</th>
						</tr>
					</thead>
					<tbody>
						{SUPPORTED_LANGUAGES.map((lang: any) => {
							const voiceC = providerColor(lang.voiceProvider);
							const sttC = providerColor(lang.sttProvider);
							return (
								<tr key={lang.code} style={{ borderBottom: '1px solid #f3f4f6' }}>
									<td style={{ ...tdStyle, fontFamily: 'monospace', fontWeight: 600 }}>
										{lang.code}
									</td>
									<td style={tdStyle}>{lang.name}</td>
									<td style={{ ...tdStyle, fontSize: '1rem' }}>{lang.native}</td>
									<td style={{ ...tdStyle, textAlign: 'center' }}>
										<ProviderBadge label={lang.voiceProvider} color={voiceC} />
									</td>
									<td style={{ ...tdStyle, textAlign: 'center' }}>
										<ProviderBadge label={lang.sttProvider} color={sttC} />
									</td>
									<td style={{ ...tdStyle, textAlign: 'center' }}>
										<span
											style={{
												display: 'inline-block',
												width: '8px',
												height: '8px',
												borderRadius: '50%',
												background: '#10b981',
											}}
											aria-label="Enabled"
										/>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			<div style={{ marginTop: '2rem' }}>
				<h2 style={{ fontSize: '1.25rem', fontWeight: 700, margin: '0 0 0.25rem' }}>
					Mixed-Language Detection
				</h2>
				<p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#6b7280' }}>
					Detected automatically from the user&apos;s input — script + Roman keyword overlap.
				</p>
				<div
					style={{
						background: '#fff',
						borderRadius: '8px',
						border: '1px solid #e5e7eb',
						padding: '1rem 1.25rem',
					}}
				>
					<div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
						{MIXED_LANGUAGES.map((m) => (
							<div
								key={m.code}
								style={{
									padding: '0.5rem 0.85rem',
									background: '#f0fdf4',
									border: '1px solid #bbf7d0',
									borderRadius: '9999px',
									fontSize: '0.85rem',
									color: '#166534',
									fontWeight: 500,
								}}
							>
								{m.label}
							</div>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}

const thStyle: React.CSSProperties = {
	textAlign: 'left',
	padding: '0.75rem 1rem',
	fontWeight: 600,
	color: '#6b7280',
	fontSize: '0.8rem',
	textTransform: 'uppercase',
};

const tdStyle: React.CSSProperties = {
	padding: '0.75rem 1rem',
	verticalAlign: 'middle',
};

function SummaryTile({
	label,
	value,
	accent,
}: {
	label: string;
	value: number;
	accent: string;
}) {
	return (
		<div
			style={{
				background: '#fff',
				border: '1px solid #e5e7eb',
				borderRadius: '8px',
				padding: '1rem 1.25rem',
			}}
		>
			<p style={{ margin: 0, fontSize: '0.75rem', color: '#6b7280', textTransform: 'uppercase' }}>
				{label}
			</p>
			<p style={{ margin: '0.25rem 0 0', fontSize: '1.75rem', fontWeight: 700, color: accent }}>
				{value}
			</p>
		</div>
	);
}

function ProviderBadge({
	label,
	color,
}: {
	label: string;
	color: { bg: string; fg: string; border: string };
}) {
	return (
		<span
			style={{
				display: 'inline-flex',
				padding: '0.2rem 0.6rem',
				borderRadius: '9999px',
				fontSize: '0.75rem',
				fontWeight: 500,
				background: color.bg,
				color: color.fg,
				border: `1px solid ${color.border}`,
			}}
		>
			{label}
		</span>
	);
}
