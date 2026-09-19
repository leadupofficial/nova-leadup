import 'package:flutter/foundation.dart';

/// Why an app may never be added to the notification allowlist.
///
/// §5.21 lists "Banking apps" and "OTP / authenticator apps" as un-selectable
/// rows, and §9.5 makes ignoring OTPs, bank alerts, passwords and auth codes
/// non-negotiable. A category here is therefore a hard block: the UI renders
/// these rows disabled with a padlock, [NotificationGuardSettings] refuses to
/// add them, and the filter re-checks them on every notification.
enum BlockedAppCategory {
  banking,
  otpAuthenticator,
  passwordManager;

  /// The heading shown on the disabled row in the settings screen.
  String get label => switch (this) {
    BlockedAppCategory.banking => 'Banking',
    BlockedAppCategory.otpAuthenticator => 'OTP / authenticator',
    BlockedAppCategory.passwordManager => 'Passwords',
  };

  /// Why it is blocked, in the words of the product brief.
  String get explanation => switch (this) {
    BlockedAppCategory.banking =>
      'Bank alerts are never read, stored or spoken (§9.5).',
    BlockedAppCategory.otpAuthenticator =>
      'One-time codes and authenticator prompts are never read, stored or '
          'spoken (§9.5).',
    BlockedAppCategory.passwordManager =>
      'Passwords and credentials are never read, stored or spoken (§9.5).',
  };
}

/// One app NOVA knows about, keyed by its Android package name.
@immutable
class KnownApp {
  const KnownApp({required this.packageName, required this.label, this.category});

  final String packageName;

  /// The name a user recognises. This is what the settings screen shows; it is
  /// never taken from the notification itself.
  final String label;

  /// Non-null when the app is permanently blocked. `null` means the user may
  /// choose it.
  final BlockedAppCategory? category;

  bool get isBlocked => category != null;

  /// The app that posted the notification is only ever identified by its
  /// package name, so this is what equals/hashCode compare on.
  @override
  bool operator ==(Object other) =>
      other is KnownApp && other.packageName == packageName;

  @override
  int get hashCode => packageName.hashCode;
}

/// The apps §5.21 draws in its mock-up. Ticking these is offered as a one-tap
/// "Use the recommended work apps" action rather than being pre-selected: a
/// fresh install must monitor nothing at all, so the default allowlist is
/// empty even before the master toggle is considered.
const List<String> kRecommendedWorkPackages = <String>[
  'com.google.android.gm', // Gmail
  'com.google.android.calendar', // Google Calendar
  'com.whatsapp.w4b', // WhatsApp Business
];

/// The app catalogue the allowlist is built from.
///
/// This is deliberately a curated list rather than an enumeration of installed
/// packages. Reading the installed-app list needs `QUERY_ALL_PACKAGES`, which
/// is a Play-restricted permission and would be a large, unjustifiable
/// widening of this feature's reach; the listener instead reports the package
/// name of any app that posts a notification, and those appear in the settings
/// screen as "Seen recently" so the user can tick them.
///
/// Entries with a non-null [KnownApp.category] are un-selectable.
const List<KnownApp> kKnownApps = <KnownApp>[
  // ── Work apps the user may allow ─────────────────────────────────────────
  KnownApp(packageName: 'com.google.android.gm', label: 'Gmail'),
  KnownApp(packageName: 'com.google.android.calendar', label: 'Google Calendar'),
  KnownApp(packageName: 'com.google.android.apps.meetings', label: 'Google Meet'),
  KnownApp(packageName: 'com.google.android.apps.dynamite', label: 'Google Chat'),
  KnownApp(packageName: 'com.google.android.apps.docs', label: 'Google Drive'),
  KnownApp(
    packageName: 'com.google.android.apps.docs.editors.docs',
    label: 'Google Docs',
  ),
  KnownApp(packageName: 'com.whatsapp.w4b', label: 'WhatsApp Business'),
  KnownApp(packageName: 'com.whatsapp', label: 'WhatsApp (personal)'),
  KnownApp(packageName: 'com.Slack', label: 'Slack'),
  KnownApp(packageName: 'com.microsoft.teams', label: 'Microsoft Teams'),
  KnownApp(packageName: 'com.microsoft.office.outlook', label: 'Outlook'),
  KnownApp(packageName: 'com.notion.id', label: 'Notion'),
  KnownApp(packageName: 'com.linear', label: 'Linear'),
  KnownApp(packageName: 'com.atlassian.android.jira.core', label: 'Jira'),
  KnownApp(packageName: 'com.asana.app', label: 'Asana'),
  KnownApp(packageName: 'com.trello', label: 'Trello'),
  KnownApp(packageName: 'com.github.android', label: 'GitHub'),
  KnownApp(packageName: 'com.basecamp.bc3', label: 'Basecamp'),
  KnownApp(packageName: 'us.zoom.videomeetings', label: 'Zoom'),

  // ── Permanent blocks: OTP / authenticator apps (§5.21) ───────────────────
  KnownApp(
    packageName: 'com.google.android.apps.authenticator2',
    label: 'Google Authenticator',
    category: BlockedAppCategory.otpAuthenticator,
  ),
  KnownApp(
    packageName: 'com.azure.authenticator',
    label: 'Microsoft Authenticator',
    category: BlockedAppCategory.otpAuthenticator,
  ),
  KnownApp(
    packageName: 'com.authy.authy',
    label: 'Authy',
    category: BlockedAppCategory.otpAuthenticator,
  ),
  KnownApp(
    packageName: 'com.beemdevelopment.aegis',
    label: 'Aegis Authenticator',
    category: BlockedAppCategory.otpAuthenticator,
  ),
  KnownApp(
    packageName: 'org.fedorahosted.freeotp',
    label: 'FreeOTP',
    category: BlockedAppCategory.otpAuthenticator,
  ),

  // ── Permanent blocks: password managers (§9.5) ───────────────────────────
  KnownApp(
    packageName: 'com.onepassword.android',
    label: '1Password',
    category: BlockedAppCategory.passwordManager,
  ),
  KnownApp(
    packageName: 'com.x8bit.bitwarden',
    label: 'Bitwarden',
    category: BlockedAppCategory.passwordManager,
  ),
  KnownApp(
    packageName: 'com.lastpass.lpandroid',
    label: 'LastPass',
    category: BlockedAppCategory.passwordManager,
  ),
  KnownApp(
    packageName: 'com.dashlane',
    label: 'Dashlane',
    category: BlockedAppCategory.passwordManager,
  ),
  KnownApp(
    packageName: 'proton.android.pass',
    label: 'Proton Pass',
    category: BlockedAppCategory.passwordManager,
  ),

  // ── Permanent blocks: banking and payment apps (§5.21) ───────────────────
  KnownApp(
    packageName: 'com.google.android.apps.walletnfcrel',
    label: 'Google Wallet',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.google.android.apps.nbu.paisa.user',
    label: 'Google Pay',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.phonepe.app',
    label: 'PhonePe',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'net.one97.paytm',
    label: 'Paytm',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'in.org.npci.upiapp',
    label: 'BHIM UPI',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.snapwork.hdfc',
    label: 'HDFC Bank',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.csam.icici.bank.imobile',
    label: 'ICICI Bank',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.sbi.lotusintouch',
    label: 'SBI YONO',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.axis.mobile',
    label: 'Axis Mobile',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.msf.kbank.mobile',
    label: 'Kotak Bank',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.idfcfirstbank.optimus',
    label: 'IDFC FIRST Bank',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.bankofbaroda.mconnect',
    label: 'Bank of Baroda',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.paypal.android.p2pmobile',
    label: 'PayPal',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.venmo',
    label: 'Venmo',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.revolut.revolut',
    label: 'Revolut',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.chase.sig.android',
    label: 'Chase',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.monzo.android',
    label: 'Monzo',
    category: BlockedAppCategory.banking,
  ),
  KnownApp(
    packageName: 'com.starlingbank.android',
    label: 'Starling Bank',
    category: BlockedAppCategory.banking,
  ),
];

/// Package-name fragments that mark an app as financial or credential-bearing,
/// and the category each one implies.
///
/// Only used for apps NOVA has never heard of, and deliberately conservative: a
/// false positive makes an app permanently un-selectable, so broad tokens such
/// as `pay` (which would catch Payroll, Paycom and similar work apps) are
/// intentionally absent. The catalogue above covers specific payment apps.
const Map<String, BlockedAppCategory> _kTreasuryPackageHints =
    <String, BlockedAppCategory>{
      'bank': BlockedAppCategory.banking,
      'wallet': BlockedAppCategory.banking,
      'paypal': BlockedAppCategory.banking,
      'paytm': BlockedAppCategory.banking,
      'phonepe': BlockedAppCategory.banking,
      'paisa': BlockedAppCategory.banking,
      'upi': BlockedAppCategory.banking,
      'authenticator': BlockedAppCategory.otpAuthenticator,
      'authy': BlockedAppCategory.otpAuthenticator,
      'freeotp': BlockedAppCategory.otpAuthenticator,
      'aegis': BlockedAppCategory.otpAuthenticator,
      'password': BlockedAppCategory.passwordManager,
      'passcode': BlockedAppCategory.passwordManager,
      'bitwarden': BlockedAppCategory.passwordManager,
      'lastpass': BlockedAppCategory.passwordManager,
      'dashlane': BlockedAppCategory.passwordManager,
      'onepassword': BlockedAppCategory.passwordManager,
    };

/// Whole words that mark an app label as financial or credential-bearing, and
/// the category each one implies.
const Map<String, BlockedAppCategory> _kTreasuryLabelHints =
    <String, BlockedAppCategory>{
      'bank': BlockedAppCategory.banking,
      'banks': BlockedAppCategory.banking,
      'banking': BlockedAppCategory.banking,
      'netbanking': BlockedAppCategory.banking,
      'passbook': BlockedAppCategory.banking,
      'wallet': BlockedAppCategory.banking,
      'authenticator': BlockedAppCategory.otpAuthenticator,
      'otp': BlockedAppCategory.otpAuthenticator,
      'password': BlockedAppCategory.passwordManager,
      'passcode': BlockedAppCategory.passwordManager,
    };

/// `\bbank\b|\bbanks\b|…` for [_kTreasuryLabelHints], longest first so
/// `netbanking` is preferred over a hypothetical shorter alternative.
final RegExp _kTreasuryLabelPattern = RegExp(
  '\\b(?:${(_kTreasuryLabelHints.keys.toList()..sort((a, b) => b.length.compareTo(a.length))).join('|')})\\b',
  caseSensitive: false,
);

/// The [KnownApp] for [packageName], or null when NOVA does not know it.
KnownApp? knownApp(String packageName) {
  for (final app in kKnownApps) {
    if (app.packageName == packageName) return app;
  }
  return null;
}

/// The [BlockedAppCategory] for [packageName], or null when it may be allowed.
///
/// Precedence, highest first:
///  1. the curated catalogue (an exact package match, so it can never be
///     overridden by a label);
///  2. a conservative package-name fragment ([_kTreasuryPackageHints]);
///  3. a whole-word label match ([_kTreasuryLabelHint]) for an unknown app.
///
/// [appLabel] is the label Android's `PackageManager` reports for the installed
/// package, never a string the notification itself supplied. An attacker can
/// choose the text of a notification but not the label of someone else's
/// installed app, so this cannot be spoofed from the notification payload.
BlockedAppCategory? blockedCategoryFor(String packageName, {String? appLabel}) {
  final catalogue = knownApp(packageName);
  if (catalogue != null) return catalogue.category;

  final lower = packageName.toLowerCase();
  for (final entry in _kTreasuryPackageHints.entries) {
    if (lower.contains(entry.key)) return entry.value;
  }

  final label = appLabel?.trim() ?? '';
  if (label.isEmpty) return null;
  final match = _kTreasuryLabelPattern.firstMatch(label);
  if (match == null) return null;
  return _kTreasuryLabelHints[match.group(0)!.toLowerCase()];
}

/// Every package this build blocks before the user can say otherwise.
Set<String> builtInBlockedPackages() {
  return <String>{
    for (final app in kKnownApps)
      if (app.isBlocked) app.packageName,
  };
}
