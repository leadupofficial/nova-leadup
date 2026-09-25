import 'dart:async';
import '../auth/auth_controller.dart';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:permission_handler/permission_handler.dart' show Permission;

import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../../core/design/widgets/index.dart';
import '../../core/permissions/permission_provider.dart';
import '../../core/permissions/permission_service.dart';
import 'onboarding_service.dart';

/// `onboarding/consent.html` — the "Permissions" step, at the export's copy,
/// radii, spacing and press motion. The mock grants with
/// `classList.add('granted')`; this asks the genuine OS permission, records every
/// decision with `NovaApi.recordConsent` / `listConsent`, and blocks Continue
/// until every row is resolved.
class ConsentPage extends ConsumerStatefulWidget {
  const ConsentPage({super.key, this.onDone});

  /// Receives the recorded outcome. When null the page pops itself, or advances
  /// to the onboarding step that follows Permissions when it is the root route.
  final ValueChanged<ConsentOutcome>? onDone;

  @override
  ConsumerState<ConsentPage> createState() => _ConsentPageState();
}

/// What the step recorded: a purpose is `true` only when access is real — the
/// OS granted it, or the user allowed an in-app setting.
typedef ConsentOutcome = Map<String, bool>;

/// Prior consent records — the screen's only remote read. Not `autoDispose`:
/// [_ConsentPageState._bootstrap] resolves `.future` from `initState`, before
/// `build` installs the `ref.watch` subscription.
final consentHistoryProvider = FutureProvider<List<NovaConsentRecord>>((ref) {
  // The router gates auth first nowadays (gate 1 in `app/router.dart`), so this
  // provider normally runs with a live token. The guard stays because edge
  // states still happen mid-onboarding — an expired 15-minute access token that
  // has not refreshed yet, for instance. It dates from the earlier pre-auth
  // onboarding flow, when `GET /consent` answered 401 for every fresh install
  // and the very first screen read "Could not load your saved choices" while
  // [_ConsentPageState._bootstrap] retried it in a loop.
  //
  // With no session there are no prior records to fetch, so this is not a
  // fallback that hides a failure: it is the correct answer for that state.
  if (!ref.watch(authStateProvider).isAuthenticated) {
    return Future<List<NovaConsentRecord>>.value(const <NovaConsentRecord>[]);
  }
  return ref.watch(novaApiProvider).listConsent();
});

/// One `.perm-card`. [permissions] is empty when the row is an in-app setting
/// with no OS gate at all; [purpose] is also what the consent API is told.
@immutable
class _RowSpec {
  const _RowSpec(this.purpose, this.emoji, this.title, this.description,
      {this.permissions = const <Permission>[], this.acknowledgeOnly = false});

  final String purpose;
  final String emoji;
  final String title;
  final String description;
  final List<Permission> permissions;

  /// True for a disclosure the user can only accept, because there is no useful
  /// "no": the row describes how a feature they are turning on actually works.
  /// Such a row renders no "Not now" button, so it never offers a refusal the app
  /// would ignore.
  final bool acknowledgeOnly;

  bool get isDevice => permissions.isNotEmpty;
}

/// The categories this step asks about, in the order the export lists them.
///
/// Two rows were removed and one added before the first store submission:
///
///  * **Contacts & Calendar** is gone. Neither platform declares the permission —
///    Android's manifest has no `READ_CONTACTS`/`READ_CALENDAR` and `Info.plist` has
///    no usage description — so the OS could never grant it. Keeping the row told a
///    reviewer the capability exists when it does not.
///  * **AI processing** is new. App Review Guideline 5.1.2(i) (and Play's Data safety
///    rules) require the app to disclose that personal data is shared with third-party
///    AI providers, name them, and obtain explicit permission first. This is that
///    disclosure, and the answer is written to the consent ledger under
///    `ai_processing`.
final List<_RowSpec> _rows = <_RowSpec>[
  const _RowSpec('microphone', '🎙', 'Microphone',
      'Needed to hear you during conversations. While NOVA is listening the microphone stays open and Android or iOS shows its own indicator. Your audio is sent to our server to be transcribed and answered — it is not processed only on this device.',
      permissions: <Permission>[Permission.microphone]),
  const _RowSpec('notifications', '🔔', 'Notifications', 'Deliver reminders and alerts you create.', permissions: <Permission>[Permission.notification]),
  const _RowSpec('recording', '⏺', 'Recording', 'Off by default. You decide when to record a meeting.'),
  const _RowSpec('memory', '🧠', 'Memory', 'Save approved facts for future conversations.'),
  const _RowSpec('ai_processing', '✨', 'AI processing',
      'NOVA answers using contracted AI providers — Sarvam AI and Deepgram for speech-to-text, ElevenLabs for voice, and Anthropic for the replies. Your voice, transcripts and messages are sent to them only to produce the answer you asked for, and are not used to train their models. This is required for NOVA to respond; if you would rather not, use the app without conversations.',
      acknowledgeOnly: true),
];

class _ConsentPageState extends ConsumerState<ConsentPage> {
  /// Genuine OS status per device row; [_decided] holds consent decisions, seeded
  /// from the server for in-app rows and always set by an explicit tap.
  final Map<String, NovaPermissionStatus> _device = {};
  final Map<String, bool> _decided = {};
  final Map<String, bool> _busy = {};
  final Map<String, String> _error = {};
  bool _checkingDevice = true;

  @override
  void initState() {
    super.initState();
    // No MediaQuery here — only provider reads and platform status checks.
    unawaited(_bootstrap());
  }

  /// Reads both real backends — the device statuses and the consent records
  /// already on the account — and applies them in one `setState` so nothing
  /// mutates before the first build.
  Future<void> _bootstrap() async {
    final service = ref.read(permissionServiceProvider);
    final device = <String, NovaPermissionStatus>{};
    final errors = <String, String>{};
    for (final row in _rows.where((row) => row.isDevice)) {
      try { device[row.purpose] = await _readStatus(service, row); }
      catch (error) { errors[row.purpose] = 'Could not read device access: ${_friendly(error)}'; }
    }
    final seeded = <String, bool>{};
    try {
      final records = await ref.read(consentHistoryProvider.future);
      for (final row in _rows.where((row) => !row.isDevice)) {
        final latest = _latestFor(records, row.purpose);
        if (latest != null) seeded[row.purpose] = latest.isActive;
      }
    } catch (_) {
      // The footer reports this; the device statuses above are already real.
    }
    if (!mounted) return;
    setState(() {
      _device.addAll(device);
      _decided.addAll(seeded);
      _error.addAll(errors);
      _checkingDevice = false;
    });
  }

  /// `PermissionService.check` for every permission behind the row.
  Future<NovaPermissionStatus> _readStatus(PermissionService service, _RowSpec row) async {
    final statuses = <NovaPermissionStatus>[];
    for (final permission in row.permissions) {
      statuses.add((await service.check(permission)).toNovaStatus());
    }
    return _combine(statuses);
  }

  /// `PermissionService.request` for one permission and
  /// `PermissionService.requestMultiple` for the contacts + calendar pair.
  Future<NovaPermissionStatus> _requestStatus(PermissionService service, _RowSpec row) async {
    if (row.permissions.length == 1) {
      return (await service.request(row.permissions.single)).toNovaStatus();
    }
    final results = await service.requestMultiple(row.permissions);
    return _combine(results.values.map((status) => status.toNovaStatus()));
  }

  /// Strictest answer wins, so a half-granted pair never reads as granted.
  NovaPermissionStatus _combine(Iterable<NovaPermissionStatus> statuses) {
    final list = statuses.toList();
    const worst = <NovaPermissionStatus>[
      NovaPermissionStatus.permanentlyDenied, NovaPermissionStatus.restricted,
      NovaPermissionStatus.denied, NovaPermissionStatus.notDetermined,
    ];
    for (final status in worst) {
      if (list.contains(status)) return status;
    }
    return NovaPermissionStatus.granted;
  }

  /// `.btn-allow`. Asks the genuine OS permission where one exists, records the
  /// genuinely effective result, and never marks a row granted that the platform
  /// did not grant.
  Future<void> _allow(_RowSpec row) async {
    if (_busy[row.purpose] ?? false) return;
    setState(() { _busy[row.purpose] = true; _error.remove(row.purpose); });
    try {
      final service = ref.read(permissionServiceProvider);
      // An in-app setting has no OS gate, so only the consent API hears about it.
      if (!row.isDevice) {
        if (await _save(row, true, 'onboarding_in_app_allow') && mounted) {
          setState(() => _decided[row.purpose] = true);
        }
        return;
      }
      // Already blocked: re-asking is a no-op, so Settings is the only way back.
      if (_device[row.purpose] == NovaPermissionStatus.permanentlyDenied) {
        await service.openSettings();
        return;
      }
      // Every device row here maps to a permission this build genuinely declares, so
      // the OS dialog is always the right call. (`canPromptOs`/`_readStatus`-only
      // rendering was removed with the Contacts & Calendar row, which was the one row
      // that could not be asked for.)
      final status = await _requestStatus(service, row);
      if (!mounted) return;
      setState(() => _device[row.purpose] = status);
      final granted = status == NovaPermissionStatus.granted;
      final saved = await _save(row, granted, 'onboarding_device_${granted ? 'granted' : status.name}');
      if (mounted && saved) setState(() => _decided[row.purpose] = granted);
    } catch (error) {
      if (mounted) setState(() => _error[row.purpose] = _friendly(error));
    } finally {
      if (mounted) setState(() => _busy[row.purpose] = false);
    }
  }

  /// `.btn-deny`. A genuine refusal: the OS is never asked, and the refusal is
  /// written to the consent API. On an in-app row it also revokes a prior allow.
  Future<void> _notNow(_RowSpec row) async {
    if (_busy[row.purpose] ?? false) return;
    setState(() => _busy[row.purpose] = true);
    try {
      final saved = await _save(row, false, 'onboarding_not_now');
      if (mounted && saved) setState(() => _decided[row.purpose] = false);
    } finally {
      if (mounted) setState(() => _busy[row.purpose] = false);
    }
  }

  /// Writes one decision — locally always, and to the server when it accepts it.
  ///
  /// The row resolves either way, deliberately. `recordConsent` needs an account
  /// and onboarding runs *before* sign-in, so on a fresh install every call fails
  /// with "Missing or invalid authorization header". Because [_resolved] accepts
  /// a non-device row only once [_decided] holds a value, and both callers set
  /// that only when this returned `true`, Continue stayed disabled forever and a
  /// new user could not get past the first screen of the app.
  ///
  /// So the choice is kept locally, as the rest of onboarding state already is,
  /// and the failure is still shown against the row so the user is told it has
  /// not synced. Returns whether the server accepted it.
  Future<bool> _save(_RowSpec row, bool granted, String method) async {
    if (mounted) {
      setState(() => _decided[row.purpose] = granted);
    }
    try {
      await ref.read(novaApiProvider).recordConsent(purpose: row.purpose, granted: granted, method: method);
      ref.invalidate(consentHistoryProvider);
      if (mounted) setState(() => _error.remove(row.purpose));
      return true;
    } catch (error) {
      // The choice has been kept locally above, so say that plainly rather than
      // leaving the raw provider error ("Missing or invalid authorization
      // header") looking like the decision failed.
      if (mounted) {
        setState(() {
          _error[row.purpose] =
              '${_friendly(error)} — saved on this device; it will sync once you sign in.';
        });
      }
      return false;
    }
  }

  /// A row is resolved once the platform answered, or once a decision — its own
  /// or one already recorded on the account — exists.
  bool _resolved(_RowSpec row) {
    if (_busy[row.purpose] ?? false) return false;
    final status = _device[row.purpose];
    if (row.isDevice && status != null && status != NovaPermissionStatus.notDetermined) return true;
    return _decided.containsKey(row.purpose);
  }

  bool _isGranted(_RowSpec row) => row.isDevice
      ? _device[row.purpose] == NovaPermissionStatus.granted
      : _decided[row.purpose] == true;

  /// The row's honest status line, its tone, and whether tapping it should open
  /// the system settings — `null` when there is nothing true to say.
  (String?, Color, bool) _caption(_RowSpec row, NovaPermissionStatus? status) {
    final c = context.nova;
    final error = _error[row.purpose];
    if (error != null) return (error, c.danger, false);
    if (_busy[row.purpose] ?? false) return (row.isDevice ? 'Asking the system…' : 'Saving your choice…', c.muted, false);
    if (row.isDevice && status == null && _checkingDevice) return ('Checking device access…', c.muted, false);
    return switch (status) {
      // `permission_handler` reports `denied` both for "refused" and for "never
      // asked", so on a fresh install this line claimed *the system did not grant
      // this* under every row before the user had tapped anything. Only say the
      // system refused once this row has actually been asked.
      NovaPermissionStatus.denied when !_decided.containsKey(row.purpose) => ('Not turned on yet — choose Allow to turn it on.', c.muted, false),
      NovaPermissionStatus.denied || NovaPermissionStatus.restricted => ('The system did not grant this. You can allow it later.', c.muted, false),
      NovaPermissionStatus.permanentlyDenied => ('Blocked by the system. Tap to open Settings.', c.danger, true),
      _ when !row.isDevice && _decided[row.purpose] == false => ('Not now — nothing is stored for this.', c.muted, false),
      _ => (null, c.muted, false),
    };
  }

  Future<void> _retry() async {
    setState(() => _checkingDevice = true);
    ref.invalidate(consentHistoryProvider);
    await _bootstrap();
  }

  void _back() {
    final router = GoRouter.maybeOf(context);
    if (router != null && router.canPop()) {
      router.pop();
      return;
    }
    Navigator.maybePop(context);
  }

  /// The system settings screen is the only way to change a blocked permission.
  void _openSettings() {
    unawaited(ref.read(permissionServiceProvider).openSettings().onError((_, _) {}));
  }

  /// `.perm-learn`. The export leaves this anchor without an `href` and the app
  /// has no Privacy Center route, so it reports the real device answer or the
  /// recorded account choice rather than navigating nowhere.
  void _learn(_RowSpec row) {
    final status = _caption(row, _device[row.purpose]).$1 ?? 'access granted by this device';
    final message = row.isDevice
        ? '${row.title}: $status'
        : '${row.title}: your choice is saved to your account; change it in Profile → Privacy controls.';
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
  }

  /// `.btn-primary`. Every decision is already written, so this only reports the
  /// outcome and moves on.
  void _finish() {
    final done = widget.onDone;
    if (done != null) {
      done(<String, bool>{for (final row in _rows) row.purpose: _isGranted(row)});
      return;
    }
    final router = GoRouter.maybeOf(context);
    if (router == null) return;
    if (router.canPop()) {
      router.pop();
      return;
    }
    router.go(OnboardingStep.profileSetup.routeName);
  }

  /// One `.perm-card` with the current real state.
  Widget _card(_RowSpec row) {
    final c = context.nova;
    final text = Theme.of(context).textTheme;
    final busy = _busy[row.purpose] ?? false;
    final granted = _isGranted(row);
    final (caption, tone, opensSettings) = _caption(row, _device[row.purpose]);

    return AnimatedContainer(
      duration: NovaMotion.ui,
      curve: Curves.ease,
      margin: const EdgeInsets.only(bottom: NovaSpace.sm),
      padding: const EdgeInsets.all(NovaSpace.md),
      decoration: BoxDecoration(
        // `.perm-card.granted` — success edge at 40%, success wash at 4%.
        color: granted ? c.success.withValues(alpha: 0.04) : c.surface,
        borderRadius: NovaRadius.rBubble,
        border: Border.all(color: granted ? c.success.withValues(alpha: 0.4) : c.border),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
        Row(children: <Widget>[
          // `.perm-icon` — 40px raised tile, 12px radius.
          Container(
            width: 40, height: 40, alignment: Alignment.center,
            decoration: BoxDecoration(color: c.surfaceRaised, borderRadius: BorderRadius.circular(NovaRadius.control)),
            child: Text(row.emoji, style: const TextStyle(fontSize: 20)),
          ),
          const SizedBox(width: NovaSpace.sm),
          // `.perm-title` — 15px display 600.
          Expanded(child: Text(row.title, style: text.titleLarge?.copyWith(fontSize: NovaType.body))),
        ]),
        const SizedBox(height: NovaSpace.xs),
        // `.perm-desc`, `.perm-actions` and `.perm-learn` all sit 52px in.
        Padding(padding: const EdgeInsets.only(left: 52), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
          Text(row.description, style: text.bodySmall?.copyWith(fontSize: 13, height: 1.5)),
          const SizedBox(height: NovaSpace.sm),
          Row(children: <Widget>[
            _PillButton(label: granted ? 'Allowed' : 'Allow', primary: true, onTap: busy || granted ? null : () => _allow(row)),
            // An acknowledgement row has no meaningful refusal, so it renders no
            // second button rather than one that would be ignored.
            if (!row.acknowledgeOnly) ...<Widget>[
              const SizedBox(width: 10),
              // A granted OS permission can only be revoked in the system settings;
              // an in-app setting can still be declined here.
              _PillButton(label: 'Not now', primary: false, onTap: busy || (row.isDevice && granted) ? null : () => _notNow(row)),
            ],
          ]),
          if (caption != null) ...<Widget>[
            const SizedBox(height: NovaSpace.xs),
            GestureDetector(
              onTap: opensSettings ? _openSettings : null,
              child: Text(caption, style: text.bodySmall?.copyWith(fontSize: NovaType.caption, height: 1.4, color: tone)),
            ),
          ],
          const SizedBox(height: NovaSpace.xs),
          GestureDetector(
            onTap: () => _learn(row),
            child: Text('Learn what is stored →', style: text.bodySmall?.copyWith(fontSize: NovaType.caption, fontWeight: NovaType.wMedium, color: c.accent)),
          ),
        ])),
      ]),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final text = Theme.of(context).textTheme;
    final history = ref.watch(consentHistoryProvider);
    final anyBusy = _rows.any((row) => _busy[row.purpose] ?? false);
    final canContinue = !_checkingDevice && !history.isLoading && !anyBusy && _rows.every(_resolved);

    // The export has no status line, but a disabled Continue with no reason would
    // be worse than one added caption. Pulling to refresh re-runs [_bootstrap].
    final note = history.hasError
        ? 'Could not load your saved choices. Pull to retry.'
        : _checkingDevice || history.isLoading
        ? 'Checking this device…'
        : !canContinue
        ? 'Choose Allow or Not now for each item to continue.'
        : (history.value?.isEmpty ?? false)
        ? 'No choices saved yet.'
        : null;

    return NovaScaffold(
      refresh: _retry,
      topBar: Row(children: <Widget>[
        NovaIconButton(icon: Icons.chevron_left_rounded, size: 36, color: c.muted, tooltip: 'Back', onTap: _back),
        // `.top-bar h1` — 19px display 700.
        Expanded(child: Center(child: Text('Permissions', style: text.headlineMedium?.copyWith(fontSize: 19)))),
        const SizedBox(width: NovaMotion.minTouchTarget),
      ]),
      // `.footer-btn` — 16/24 padding on the page background.
      bottomNav: Container(
        color: c.bg,
        padding: const EdgeInsets.fromLTRB(NovaSpace.gutter, NovaSpace.md, NovaSpace.gutter, NovaSpace.md),
        child: Column(mainAxisSize: MainAxisSize.min, children: <Widget>[
          if (note != null) Padding(
            padding: const EdgeInsets.only(bottom: NovaSpace.xs),
            child: Text(note, textAlign: TextAlign.center, style: text.bodySmall?.copyWith(fontSize: NovaType.caption, height: 1.4, color: history.hasError ? c.danger : c.muted)),
          ),
          NovaPrimaryButton(label: 'Continue', busy: anyBusy, onPressed: canContinue ? _finish : null),
        ]),
      ),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: <Widget>[
        const SizedBox(height: NovaSpace.xs),
        // `.heading` — 34px display 800 clipped to a 180deg gradient. The export's
        // second stop (`oklch(0.70 0.01 260)`) has no token, so the equivalent
        // point between --fg and --muted is used.
        ShaderMask(
          shaderCallback: (bounds) => LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: <Color>[c.fg, Color.lerp(c.fg, c.muted, 0.65)!]).createShader(bounds),
          blendMode: BlendMode.srcIn,
          child: Text('Choose what NOVA can access', style: text.displayLarge?.copyWith(fontSize: 34, height: 1.1, letterSpacing: -1.02)),
        ),
        const SizedBox(height: NovaSpace.sm),
        Text('Every permission is purpose-specific. You can change these later in Profile → Privacy controls.',
            style: text.bodyLarge?.copyWith(color: c.muted, height: 1.5)),
        // `.sub` margin-bottom: 28px.
        const SizedBox(height: NovaSpace.lg + NovaSpace.xxs),
        for (final row in _rows) _card(row),
      ]),
    );
  }
}

/// `.btn-sm` — 8/20 padding, pill radius, 13px display label and the export's
/// 120ms `scale(0.96)` press, inside a 44px hit area (brand-spec rule 5).
class _PillButton extends StatefulWidget {
  const _PillButton({required this.label, required this.primary, this.onTap});

  final String label;
  final bool primary;
  final VoidCallback? onTap;

  @override
  State<_PillButton> createState() => _PillButtonState();
}

class _PillButtonState extends State<_PillButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final enabled = widget.onTap != null;
    final foreground = widget.primary ? c.onAccent : c.muted;
    final pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
      decoration: BoxDecoration(
        gradient: widget.primary ? c.accentGradient : null,
        color: widget.primary ? null : c.surfaceRaised,
        borderRadius: NovaRadius.rPill,
        border: widget.primary ? null : Border.all(color: c.border),
        // `.btn-allow` — `0 12px 30px -10px accent/40%`.
        boxShadow: widget.primary
            ? <BoxShadow>[BoxShadow(color: c.accent.withValues(alpha: 0.4), blurRadius: 30, spreadRadius: -10, offset: const Offset(0, 12))]
            : null,
      ),
      child: Text(widget.label, style: Theme.of(context).textTheme.titleLarge?.copyWith(fontSize: 13, color: foreground)),
    );

    return GestureDetector(
      onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
      onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
      onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
      onTap: widget.onTap,
      behavior: HitTestBehavior.opaque,
      // brand-spec rule 5: the pill keeps its designed size inside a 44px target.
      child: Container(
        height: NovaMotion.minTouchTarget,
        alignment: Alignment.center,
        child: AnimatedScale(
          scale: _pressed ? 0.96 : 1,
          duration: NovaMotion.fast,
          curve: Curves.easeOut,
          child: AnimatedOpacity(
            opacity: enabled ? 1 : 0.55,
            duration: NovaMotion.uiMin,
            child: pill,
          ),
        ),
      ),
    );
  }
}

/// `NovaApiException(401): Unauthorized` → `Unauthorized`.
String _friendly(Object error) =>
    error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');

/// The most recent consent record for [purpose], whatever order the API used.
NovaConsentRecord? _latestFor(List<NovaConsentRecord> records, String purpose) {
  DateTime? at(NovaConsentRecord r) => r.revokedAt ?? r.consentedAt;
  final matching = records.where((record) => record.purpose == purpose).toList()
    ..sort((a, b) {
      final (x, y) = (at(a), at(b));
      if (x == null) return 1;
      if (y == null) return -1;
      return y.compareTo(x);
    });
  return matching.isEmpty ? null : matching.first;
}
