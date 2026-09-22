/**
 * Public support page.
 *
 * Both stores require a **Support URL** in the listing metadata, and App Review
 * Guideline 1.5 asks for a way to contact the developer. Neither existed: the only
 * contact channel in the repository was the `privacy@leadup.tech` address inside the
 * privacy policy, and there was no support or marketing URL anywhere.
 *
 * Like `/privacy` and `/delete-account`, this is served by the console (the app that
 * answers on the public origin) and is exempted from the session gate in
 * `src/middleware.ts`. Enter the URL below in App Store Connect's "Support URL" field
 * and Play Console's store listing.
 *
 * It is deliberately plain static JSX with no data fetching: a support page that can
 * 500 is worse than no support page, because that is the URL a user reaches when
 * something has already gone wrong.
 */

export const metadata = {
	title: 'Support — NOVA',
	description: 'How to get help with NOVA, and how to reach us.',
};

const H2 = ({ children }: { children: React.ReactNode }) => (
	<h2 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '2rem 0 0.5rem' }}>{children}</h2>
);
const P = ({ children }: { children: React.ReactNode }) => (
	<p style={{ margin: '0 0 0.75rem', fontSize: '0.9rem', lineHeight: 1.65 }}>{children}</p>
);
const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
	<a href={href} style={{ color: '#1d4ed8' }}>
		{children}
	</a>
);

export default function SupportPage() {
	return (
		<main
			style={{
				maxWidth: '720px',
				margin: '0 auto',
				padding: '3rem 1.25rem 5rem',
				background: '#fff',
				color: '#111827',
				minHeight: '100vh',
			}}
		>
			<h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0 }}>NOVA Support</h1>
			<p style={{ margin: '0.35rem 0 1.5rem', color: '#6b7280', fontSize: '0.85rem' }}>
				Leadup Technologies · last updated 20 September 2026
			</p>

			<P>
				Something not working, or a question about your account? Email us and a person
				will reply. We aim to answer within two working days.
			</P>

			<P>
				<strong>
					<A href="mailto:support@leadup.tech">support@leadup.tech</A>
				</strong>
			</P>

			<H2>Deleting your account</H2>
			<P>
				You do not need to contact us for this. Open NOVA and go to{' '}
				<strong>Profile → Delete account</strong>, or use the{' '}
				<A href="/delete-account">account deletion page</A>. Your account, conversations,
				tasks, reminders, memories and recordings are removed immediately. See the{' '}
				<A href="/privacy">privacy policy</A> for exactly what is removed and what is
				retained.
			</P>

			<H2>Reporting a reply</H2>
			<P>
				Every answer NOVA gives has a <strong>Report</strong> link under it. Use it if a
				reply is harmful, sexual, hateful or otherwise unsafe; reports reach us with the
				reply and your account so it can be reviewed. You do not need to leave the app.
			</P>

			<H2>Voice and microphone</H2>
			<P>
				NOVA listens while you are talking to it, while you have started a recording, and —
				if you have switched wake-word listening on — in between, so it can hear its own
				name. The wake word itself is detected on your device, and Android and iOS both
				show their own indicator while the microphone is open. Turning the microphone
				permission off in system settings stops all of it. If transcription is failing, check that you have a network connection —
				speech is transcribed on our server, not on the device.
			</P>

			<H2>Notifications</H2>
			<P>
				Reminders and the daily briefing are delivered by your own device, so if they are
				not arriving check that notifications are allowed for NOVA in system settings.
				Android may also deliver a reminder a few minutes late until you allow
				&quot;Alarms &amp; reminders&quot; — NOVA offers that from the Reminders screen.
			</P>

			<H2>Signing in</H2>
			<P>
				NOVA signs in with an email address and password. Phone sign-in is not available
				on this server, and the app says so rather than offering a button that cannot
				work. If you have forgotten your password, email us from the address on the
				account.
			</P>

			<H2>Privacy and your data</H2>
			<P>
				The <A href="/privacy">privacy policy</A> lists every category of data NOVA
				collects, who processes it, how long it is kept and how to have it deleted. In
				short: your voice and text go to contracted AI providers to produce the answer you
				asked for, and nothing is sold or shared with data brokers.
			</P>

			<H2>Security</H2>
			<P>
				If you believe you have found a security problem, email{' '}
				<A href="mailto:security@leadup.tech">security@leadup.tech</A> rather than using
				the general address, and please do not test against other people&apos;s accounts.
			</P>

			<H2>Company</H2>
			<P>
				Leadup Technologies. NOVA is a voice companion for tasks, reminders, memories and
				meeting notes.
			</P>
		</main>
	);
}
