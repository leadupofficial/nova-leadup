/**
 * The privacy policy exists in two places, and both stores require both of them.
 *
 *  * `apps/admin/src/app/privacy/page.tsx` — the **public URL** entered in App Store
 *    Connect and on the Play Console Data safety form.
 *  * `apps/mobile/lib/features/settings/privacy_policy_page.dart` — the **in-app copy**.
 *    App Review 5.1.1(i) and Play's User Data policy require the policy to be readable
 *    inside the app, not merely linked from the listing.
 *
 * They were hand-duplicated, and they drifted: the in-app copy gained "No health,
 * fitness or step data" (because onboarding stopped collecting any) while the public
 * page did not, so the URL a reviewer opens and the text they read in the app
 * disagreed about health data. Nothing caught it, because nothing compared them. This
 * test is that comparison.
 *
 * It deliberately asserts only on the *shared claims* — the facts that must be true in
 * both — rather than on exact equality, because the two are formatted for different
 * media (JSX list items vs Dart string literals) and the app copy additionally states
 * its own public URL.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '../../../..');

const PUBLIC_POLICY = resolve(REPO_ROOT, 'apps/admin/src/app/privacy/page.tsx');
const IN_APP_POLICY = resolve(
  REPO_ROOT,
  'apps/mobile/lib/features/settings/privacy_policy_page.dart',
);

/** Collapses JSX/Dart source into comparable prose. */
function flatten(source: string): string {
  return (
    source
      // Protect URL schemes first: the `//` in `https://` is not a comment, and
      // stripping it as one truncated every URL to `https:`.
      .replace(/:\/\//g, ':@@SCHEME@@')
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&apos;/g, "'")
      .replace(/&mdash;/g, '—')
      .replace(/@@SCHEME@@/g, '//')
      .replace(/\s+/g, ' ')
  );
}

const publicCopy = flatten(readFileSync(PUBLIC_POLICY, 'utf8'));
const inAppCopy = flatten(readFileSync(IN_APP_POLICY, 'utf8'));

/**
 * Claims that must appear verbatim in both copies. Each one is something a store
 * reviewer or a user could rely on, and each is checkable against the code.
 */
const SHARED_CLAIMS: ReadonlyArray<readonly [string, string]> = [
  ['no advertising identifier', 'No advertising identifier, and no advertising or attribution SDKs.'],
  ['no contacts/calendar/camera', 'No contacts, calendar, camera or photo library access.'],
  ['no location tracking', 'No location tracking.'],
  ['no health data', 'No health, fitness or step data.'],
  ['otp refusal', 'refuse to read or store them aloud'],
  ['audio leaves the device', 'audio is streamed to our server to be transcribed'],
  ['named AI subprocessors', 'Anthropic'],
  ['named STT provider', 'Deepgram'],
  ['named voice provider', 'ElevenLabs'],
  ['named Indian provider', 'Sarvam'],
  ['privacy contact', 'privacy@leadup.tech'],
  ['30-day deletion', '30 days'],
  ['retention section', 'How long we keep it'],
];

describe('privacy policy — the two published copies agree', () => {
  it.each(SHARED_CLAIMS)('both copies state: %s', (_label, claim) => {
    expect(publicCopy, `missing from apps/admin/src/app/privacy/page.tsx: "${claim}"`).toContain(
      claim,
    );
    expect(
      inAppCopy,
      `missing from apps/mobile/lib/features/settings/privacy_policy_page.dart: "${claim}"`,
    ).toContain(claim);
  });

  it('neither copy claims a capability the app does not have', () => {
    // The health line exists precisely because onboarding used to solicit health data
    // it could not read. If a future edit re-adds such a feature, this assertion is
    // where the two copies and the code get reconciled.
    for (const copy of [publicCopy, inAppCopy]) {
      expect(copy).not.toContain('steps inform your daily summary');
      expect(copy).not.toContain('Share health data');
    }
  });

  it('the in-app copy names the public URL it mirrors', () => {
    // So the two cannot silently diverge on where the canonical policy lives.
    expect(inAppCopy).toContain('https://nova.leadup.in/privacy');
  });
});
