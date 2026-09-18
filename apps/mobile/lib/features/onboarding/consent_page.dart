import 'dart:async';

import 'package:flutter/foundation.dart' show TargetPlatform, defaultTargetPlatform;
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
/// 18px card radius, 52px action indent, 12/16/28px rhythm and 120ms press.
/// The mock grants with `classList.add('granted')`; this asks the genuine OS
/// permission, records every decision with `NovaApi.recordConsent`, reads prior
/// state with `NovaApi.listConsent`, and blocks Continue until every row is
/// resolved.
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

// ─── Providers (owned by this screen; core/api is untouched) ─────────────────
/// Prior consent records — the screen's only remote read. Not `autoDispose`:
/// [_ConsentPageState._bootstrap] resolves `.future` from `initState`, before
/// `build` installs the `ref.watch` subscription.
final consentHistoryProvider = FutureProvider<List<NovaConsentRecord>>((ref) {
  return ref.watch(novaApiProvider).listConsent();
});

// ─── The export's five rows, mapped to real backends ─────────────────────────
/// One `.perm-card`. [permissions] is empty when the row is an in-app setting
/// with no OS gate at all; [purpose] is also what the consent API is told.
@immutable
class _RowSpec {
  const _RowSpec(
    this.purpose,
    this.emoji,
    this.title,
    this.description, {
    this.permissions = const <Permission>[],
    this.canPromptOs = true,
  });

  final String purpose;
  final String emoji;
  final String title;
  final String description;
  final List<Permission> permissions;

  /// False when this build must not raise the system dialog for [permissions].
  final bool canPromptOs;

  bool get isDevice => permissions.isNotEmpty;
}

/// Android's manifest declares no `READ_CONTACTS`/`READ_CALENDAR` and iOS's
/// `Runner/Info.plist` has no contacts/calendar usage description; both are
/// pre-existing files outside this screen's scope. On Android the request is
/// still issued — the OS answers "denied" for an undeclared permission, which is
/// its own honest answer — but on iOS it would terminate the process instead of
/// returning, so there the row only reads the status.
bool get _canPromptContacts => defaultTargetPlatform != TargetPlatform.iOS;

final List<_RowSpec> _rows = <_RowSpec>[
  const _RowSpec('microphone', '🎙', 'Microphone', 'Needed to hear you during conversations. Always visible while active.', permissions: <Permission>[Permission.microphone]),
  const _RowSpec('notifications', '🔔', 'Notifications', 'Deliver reminders and alerts you create.', permissions: <Permission>[Permission.notification]),
  const _RowSpec('recording', '⏺', 'Recording', 'Off by default. You decide when to record a meeting.'),
  const _RowSpec('memory', '🧠', 'Memory', 'Save approved facts for future conversations.'),
  _RowSpec('contacts_calendar', '📅', 'Contacts & Calendar', 'Optional. Connect only when you want help scheduling.',
      permissions: const <Permission>[Permission.contacts, Permission.calendarFullAccess], canPromptOs: _canPromptContacts),
];

// ─── State ───────────────────────────────────────────────────────────────────
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
      try {
        device[row.purpose] = await _readStatus(service, row);
      } catch (error) {
        errors[row.purpose] = 'Could not read device access: ${_friendly(error)}';
      }
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
    for (final status in const <NovaPermissionStatus>[
      NovaPermissionStatus.permanentlyDenied,
      NovaPermissionStatus.restricted,
      NovaPermissionStatus.denied,
      NovaPermissionStatus.notDetermined,
    ]) {
      if (list.contains(status)) return status;
    }
    return NovaPermissionStatus.granted;
  }

  /// `.btn-allow`. Asks the genuine OS permission where one exists, records the
  /// genuinely effective result, and never marks a row granted that the platform
  /// did not grant.
  Future<void> _allow(_RowSpec row) async {
    if (_busy[row.purpose] ?? false) return;
    setState(() {
      _busy[row.purpose] = true;
      _error.remove(row.purpose);
    });
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
      if (row.canPromptOs && _device[row.purpose] == NovaPermissionStatus.permanentlyDenied) {
        await service.openSettings();
        return;
      }
      // `check` where this build must not raise the dialog ([_canPromptContacts]).
      final status = row.canPromptOs ? await _requestStatus(service, row) : await _readStatus(service, row);
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

  /// Writes one decision. Returns false when the server did not accept it, so the
  /// row stays unresolved instead of reporting an unsaved choice.
  Future<bool> _save(_RowSpec row, bool granted, String method) async {
    try {
      await ref.read(novaApiProvider).recordConsent(purpose: row.purpose, granted: granted, method: method);
      ref.invalidate(consentHistoryProvider);
      return true;
    } catch (error) {
      if (mounted) setState(() => _error[row.purpose] = _friendly(error));
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
    if (_busy[row.purpose] ?? false) {
      return (row.isDevice ? 'Asking the system…' : 'Saving your choice…', c.muted, false);
    }
    if (row.isDevice && status == null && _checkingDevice) return ('Checking device access…', c.muted, false);
    if (row.isDevice && !row.canPromptOs && status == NovaPermissionStatus.notDetermined) {
      return ('This build cannot ask the system for this permission.', c.warning, false);
    }
    return switch (status) {
      NovaPermissionStatus.denied || NovaPermissionStatus.restricted =>
        ('The system did not grant this. You can allow it later.', c.muted, false),
      NovaPermissionStatus.permanentlyDenied =>
        ('Blocked by the system. Tap to open Settings.', c.danger, true),
      _ when !row.isDevice && _decided[row.purpose] == false =>
        ('Not now — nothing is stored for this.', c.muted, false),
      _ => (null, c.muted, false),
    };
  }

  void _retry() {
    setState(() => _checkingDevice = true);
    ref.invalidate(consentHistoryProvider);
    unawaited(_bootstrap());
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
        : '${row.title}: your choice is saved to your account. Change it any '
              'time in Profile → Privacy controls.';
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
            const SizedBox(width: 10),
            // A granted OS permission can only be revoked in the system settings;
            // an in-app setting can still be declined here.
            _PillButton(label: 'Not now', primary: false, onTap: busy || (row.isDevice && granted) ? null : () => _notNow(row)),
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
      refresh: () async => _retry(),
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
          if (note != null)
            Padding(
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
          shaderCallback: (bounds) => LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: <Color>[c.fg, Color.lerp(c.fg, c.muted, 0.65)!],
          ).createShader(bounds),
          blendMode: BlendMode.srcIn,
          child: Text('Choose what NOVA can access', style: text.displayLarge?.copyWith(fontSize: 34, height: 1.1, letterSpacing: -1.02)),
        ),
        const SizedBox(height: NovaSpace.sm),
        Text(
          'Every permission is purpose-specific. You can change these later '
          'in Privacy Center.',
          style: text.bodyLarge?.copyWith(color: c.muted, height: 1.5),
        ),
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

    return GestureDetector(
      onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
      onTapUp: enabled ? (_) => setState(() => _pressed = false) : null,
      onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
      onTap: widget.onTap,
      behavior: HitTestBehavior.opaque,
      child: SizedBox(
        height: NovaMotion.minTouchTarget,
        child: Center(
          child: AnimatedScale(
            scale: _pressed ? 0.96 : 1,
            duration: NovaMotion.fast,
            curve: Curves.easeOut,
            child: AnimatedOpacity(
              opacity: enabled ? 1 : 0.55,
              duration: NovaMotion.uiMin,
              child: Container(
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
              ),
            ),
          ),
        ),
      ),
    );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
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
