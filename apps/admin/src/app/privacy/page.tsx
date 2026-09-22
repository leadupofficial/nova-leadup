/**
 * Public privacy policy.
 *
 * Both stores require a publicly reachable privacy-policy URL before an app can be
 * published, and App Store Connect will not let a submission proceed without one. The
 * console is what serves `https://nova.leadup.in/`, so the policy lives here and is
 * exempted from the session gate in `src/middleware.ts`.
 *
 * It has to stay true to three other artefacts: `ios/Runner/PrivacyInfo.xcprivacy`, the
 * App Store Connect privacy questionnaire, and the Google Play Data Safety form. If a
 * provider is added or removed, all four change together.
 */

export const metadata = {
	title: 'Privacy Policy — NOVA',
	description: 'What NOVA collects, who processes it, and how to delete it.',
};

const H2 = ({ children }: { children: React.ReactNode }) => (
	<h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '2rem 0 0.5rem' }}>{children}</h2>
);
const P = ({ children }: { children: React.ReactNode }) => (
	<p style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', lineHeight: 1.65 }}>{children}</p>
);
const LI = ({ children }: { children: React.ReactNode }) => (
	<li style={{ marginBottom: '0.35rem', fontSize: '0.9rem', lineHeight: 1.6 }}>{children}</li>
);

export default function PrivacyPolicyPage() {
	return (
		<main
			style={{
				maxWidth: '760px',
				margin: '0 auto',
				padding: '3rem 1.25rem 5rem',
				background: '#fff',
				color: '#111827',
				minHeight: '100vh',
			}}
		>
			<h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0 }}>NOVA Privacy Policy</h1>
			<p style={{ margin: '0.35rem 0 1.5rem', color: '#6b7280', fontSize: '0.85rem' }}>
				Leadup Technologies · Last updated 20 September 2026
			</p>

			<P>
				NOVA is a voice companion. It listens when you talk to it, answers, and keeps the
				tasks, reminders and notes you ask it to. This page explains exactly what leaves
				your device, who processes it, and how to get rid of it.
			</P>

			<H2>What we collect</H2>
			<ul style={{ paddingLeft: '1.2rem', margin: '0 0 0.75rem' }}>
				<LI>
					<strong>Account details</strong> — the email address, password (stored only as a
					bcrypt hash) and optional name you sign up with.
				</LI>
				<LI>
					<strong>Voice audio</strong> — while you are talking to NOVA, or while you have
					started a recording, audio is streamed to our server to be transcribed. The
					microphone is open during those two states, and also while wake-word listening is
					switched on (the wake word itself is detected on the device). Android and iOS both show
					their own indicator while it is.
				</LI>
				<LI>
					<strong>Transcripts and answers</strong> — the text of what you said, NOVA&apos;s
					reply, and the audio we synthesise for it.
				</LI>
				<LI>
					<strong>Your content</strong> — tasks, reminders, and the memories you approve.
				</LI>
				<LI>
					<strong>Recordings you make or import</strong> — a meeting you record in the app,
					or a call recording you point NOVA at from your own phone&apos;s recorder, plus the
					transcript and summary produced from it.
				</LI>
				<LI>
					<strong>Notifications</strong> — only if you turn the notification assistant on
					and grant Notification Access. NOVA reads the app, title and body to decide
					whether the alert is worth telling you about, and it does not store the text:
					the inbox is in memory and is gone when the app closes.
				</LI>
				<LI>
					<strong>Diagnostics</strong> — crash reports and basic usage events (app opened,
					wake word used, feature used) through Firebase Crashlytics and Firebase
					Analytics, tied to an app-instance identifier rather than to an advertising ID.
				</LI>
			</ul>

			<H2>What we do not collect</H2>
			<ul style={{ paddingLeft: '1.2rem', margin: '0 0 0.75rem' }}>
				<LI>No advertising identifier, and no advertising or attribution SDKs.</LI>
				<LI>No contacts, calendar, camera or photo library access.</LI>
				<LI>No location tracking.</LI>
				{/* Kept identical to the in-app policy (`privacy_policy_page.dart`). This line
				    was missing here while the app had it, so the published URL and the copy a
				    reviewer reads inside the app disagreed about health data — and the
				    onboarding no longer collects any, which makes the claim true of both. */}
				<LI>No health, fitness or step data.</LI>
				<LI>
					No one-time passwords, banking alerts or authentication codes: NOVA is built to
					refuse to read or store them aloud, and they are filtered before they reach the
					assistant.
				</LI>
			</ul>

			<H2>Who processes it</H2>
			<P>
				Speech-to-text, text-to-speech and the language model that writes NOVA&apos;s
				replies are provided by contracted service providers (currently Sarvam AI,
				Deepgram, ElevenLabs and Anthropic). Your audio and text are sent to them only to
				produce the answer you asked for. Recordings and other files are stored in object
				storage (self-hosted, S3-compatible). Crash and usage data go to Google Firebase. We do
				not sell
				personal data and we do not share it with data brokers.
			</P>

			<H2>How long we keep it</H2>
			<P>
				Account data and the content you create are kept until you delete them or delete
				your account. Recordings and transcripts stay until you delete the recording.
				Notification text is never written to disk. Crash reports are retained by Firebase
				under its own retention settings.
			</P>

			<H2>Deleting your data</H2>
			<P>
				You can delete individual tasks, reminders and memories inside the app at any
				time, and recordings are removed automatically under the retention window you
				choose in Profile → Privacy controls. To delete your whole account and everything
				in it, use{' '}
				<strong>Profile → Delete account</strong> in the app, or email{' '}
				<a href="mailto:privacy@leadup.tech" style={{ color: '#1d4ed8' }}>
					privacy@leadup.tech
				</a>{' '}
				from the address you signed up with. We complete deletion requests within 30 days.
			</P>

			<H2>Security</H2>
			<P>
				Traffic between the app and our servers uses TLS. Passwords are hashed with bcrypt
				and never stored in plain text. Access tokens are short-lived, refresh tokens are
				hashed at rest, and logging redacts credentials, tokens and provider responses.
			</P>

			<H2>Children</H2>
			<P>
				NOVA is not directed at children under 13, and we do not knowingly collect their
				data. If you believe a child has created an account, contact us and we will remove
				it.
			</P>

			<H2>Changes</H2>
			<P>
				If this policy changes in a way that affects what is collected, we will say so in
				the app before the change takes effect.
			</P>

			<H2>Contact</H2>
			<P>
				Leadup Technologies —{' '}
				<a href="mailto:privacy@leadup.tech" style={{ color: '#1d4ed8' }}>
					privacy@leadup.tech
				</a>
			</P>
		</main>
	);
}
