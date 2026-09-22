import 'package:flutter/material.dart';

import '../../core/design/widgets/index.dart';

/// The privacy policy, readable **inside** the app.
///
/// Both stores require this to exist as a public URL, and both additionally require
/// the policy to be reachable from within the app itself:
///
///  * App Review Guideline 5.1.1(i) — the app must have a privacy policy link; and
///  * Google Play's User Data policy — "a privacy policy link or text within the app
///    itself".
///
/// The text below is the same policy published at
/// [publicUrl] (served by `apps/admin/src/app/privacy/page.tsx`). It is duplicated
/// rather than fetched so it renders with no network, and because a policy URL that
/// 404s is exactly the failure this screen exists to prevent. **If one changes, the
/// other must change with it** — along with `ios/Runner/PrivacyInfo.xcprivacy`, the
/// App Store Connect privacy questionnaire and the Play Data safety form.
class PrivacyPolicyPage extends StatelessWidget {
  const PrivacyPolicyPage({super.key});

  /// The canonical, publicly reachable policy URL. Given to App Store Connect and to
  /// the Play Console Data safety form.
  static const String publicUrl = 'https://nova.leadup.in/privacy';

  /// Shown on the published page and here. Bump both together.
  static const String lastUpdated = '20 September 2026';

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return NovaScaffold(
      topBar: Row(
        children: [
          if (Navigator.of(context).canPop())
            NovaIconButton(
              icon: Icons.chevron_left_rounded,
              size: 36,
              radius: NovaRadius.control,
              tooltip: 'Back',
              onTap: () => Navigator.of(context).pop(),
            )
          else
            const SizedBox(width: NovaMotion.minTouchTarget),
          Expanded(
            child: Center(
              child: Text(
                'Privacy Policy',
                style: NovaTheme.sectionHeading(c).copyWith(fontSize: 19),
              ),
            ),
          ),
          const SizedBox(width: NovaMotion.minTouchTarget),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'NOVA Privacy Policy · last updated $lastUpdated',
            style: TextStyle(color: c.muted, fontSize: NovaType.bodySmall),
          ),
          const SizedBox(height: NovaSpace.md),
          const NovaCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _P(
                  'NOVA is a voice companion. It listens when you talk to it, answers, '
                  'and keeps the tasks, reminders and notes you ask it to. This page '
                  'explains exactly what leaves your device, who processes it, and how '
                  'to get rid of it.',
                ),
              ],
            ),
          ),
          const SizedBox(height: NovaSpace.md),
          const _Section(
            title: 'What we collect',
            bullets: [
              'Account details — the email address, password (stored only as a bcrypt '
                  'hash) and optional name you sign up with.',
              'Voice audio — while you are talking to NOVA, or while you have started a '
                  'recording, audio is streamed to our server to be transcribed. The '
                  'microphone is open during those two states, and also while wake-word '
                  'listening is switched on (the wake word itself is detected on the device). '
                  'Android and iOS '
                  'both show their own indicator while it is.',
              'Transcripts and answers — the text of what you said, NOVA\'s reply, and '
                  'the audio we synthesise for it.',
              'Your content — tasks, reminders, and the memories you approve.',
              'Recordings you make or import — a meeting you record in the app, or a '
                  'call recording you point NOVA at from your own phone\'s recorder, plus '
                  'the transcript and summary produced from it.',
              'Notifications — only if you turn the notification assistant on and grant '
                  'Notification Access. NOVA reads the app, title and body to decide '
                  'whether the alert is worth telling you about, and it does not store '
                  'the text: the inbox is in memory and is gone when the app closes.',
              'Diagnostics — crash reports and basic usage events (app opened, wake word '
                  'used, feature used) through Firebase Crashlytics and Firebase '
                  'Analytics, tied to an app-instance identifier rather than to an '
                  'advertising ID.',
            ],
          ),
          const _Section(
            title: 'What we do not collect',
            bullets: [
              'No advertising identifier, and no advertising or attribution SDKs.',
              'No contacts, calendar, camera or photo library access.',
              'No location tracking.',
              'No health, fitness or step data.',
              'No one-time passwords, banking alerts or authentication codes: NOVA is '
                  'built to refuse to read or store them aloud, and they are filtered '
                  'before they reach the assistant.',
            ],
          ),
          const _Section(
            title: 'Who processes it',
            body:
                'Speech-to-text, text-to-speech and the language model that writes '
                'NOVA\'s replies are provided by contracted service providers (Sarvam AI, '
                'Deepgram, ElevenLabs and Anthropic). Your audio and text are sent to '
                'them only to produce the answer you asked for. Recordings and other '
                'files are stored in our own S3-compatible object storage on our servers. Crash '
                'and usage data go '
                'to Google Firebase. We do not sell personal data and we do not share it '
                'with data brokers.',
          ),
          const _Section(
            title: 'How long we keep it',
            body:
                'Account data and the content you create are kept until you delete them '
                'or delete your account. Recordings and transcripts stay until you delete '
                'the recording. Notification text is never written to disk. Crash reports '
                'are retained by Firebase under its own retention settings.',
          ),
          const _Section(
            title: 'Deleting your data',
            body:
                'You can delete individual tasks, reminders and memories in '
                'the app at any time, and recordings are removed automatically under the '
                'retention window you choose in Profile → Privacy controls. To delete your '
                'whole account and everything in it, open Profile → Delete account, or email '
                'privacy@leadup.tech from the address you signed up with. We verify and '
                'complete deletion requests within 30 days.',
          ),
          const _Section(
            title: 'Security',
            body:
                'Traffic between the app and our servers uses TLS. Passwords are hashed '
                'with bcrypt and never stored in plain text. Access tokens are '
                'short-lived, refresh tokens are hashed at rest, and logging redacts '
                'credentials, tokens and provider responses.',
          ),
          const _Section(
            title: 'Children',
            body:
                'NOVA is not directed at children under 13, and we do not knowingly '
                'collect their data. If you believe a child has created an account, '
                'contact us and we will remove it.',
          ),
          const _Section(
            title: 'Changes',
            body:
                'If this policy changes in a way that affects what is collected, we will '
                'say so in the app before the change takes effect.',
          ),
          const _Section(
            title: 'Contact',
            body: 'Leadup Technologies — privacy@leadup.tech',
          ),
          const SizedBox(height: NovaSpace.md),
          Text(
            'Also published at $publicUrl',
            style: TextStyle(color: c.muted, fontSize: NovaType.bodySmall),
          ),
          const SizedBox(height: NovaSpace.xl),
        ],
      ),
    );
  }
}

class _Section extends StatelessWidget {
  const _Section({required this.title, this.body, this.bullets});

  final String title;
  final String? body;
  final List<String>? bullets;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Padding(
      padding: const EdgeInsets.only(bottom: NovaSpace.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: NovaTheme.sectionHeading(c).copyWith(fontSize: 15)),
          const SizedBox(height: NovaSpace.xs),
          if (body != null) _P(body!),
          for (final bullet in bullets ?? const <String>[])
            Padding(
              padding: const EdgeInsets.only(bottom: 6),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.only(top: 6, right: 8),
                    child: Container(
                      width: 4,
                      height: 4,
                      decoration: BoxDecoration(color: c.accent, shape: BoxShape.circle),
                    ),
                  ),
                  Expanded(child: _P(bullet)),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

class _P extends StatelessWidget {
  const _P(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: TextStyle(
        color: context.nova.fg,
        fontSize: NovaType.bodySmall,
        height: 1.55,
      ),
    );
  }
}
