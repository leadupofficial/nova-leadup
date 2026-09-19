import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/api/nova_api.dart';
import '../../core/api/providers.dart';
import '../../core/design/widgets/index.dart';
import '../../core/voice/wake_word_controller.dart';
import '../../core/voice/wake_word_service.dart' show humanizeWakeWordName;

/// Wake word settings (requirement 2; master document §5.16, §13.10).
///
/// The screen exists to be honest about four things:
///
///  * which classifier the device will actually listen for — read from the
///    native service, never hardcoded;
///  * whether there is anything to choose between. Today's build installs
///    exactly one classifier (`hey_jarvis`), so there is not, and the screen
///    says so instead of drawing a one-row picker that does nothing;
///  * what switching would take: another ONNX classifier in the app bundle,
///    documented in `android/app/src/main/assets/wakeword/README.md`. No "Hey
///    Nova" model exists in this repository;
///  * what §13.10 records. The server stores the user's choice against their
///    account; it cannot change what the microphone listens for, and the screen
///    never implies it can.
///
/// The wake-word path opens the conversation only. It cannot dispatch a device
/// action, and the "What a wake word can and cannot do" card says so plainly.
class WakeWordSettingsPage extends ConsumerStatefulWidget {
  const WakeWordSettingsPage({super.key});

  @override
  ConsumerState<WakeWordSettingsPage> createState() =>
      _WakeWordSettingsPageState();
}

class _WakeWordSettingsPageState extends ConsumerState<WakeWordSettingsPage> {
  /// True while a selection is being persisted and applied.
  bool _busy = false;

  /// Result of the last account-record write, shown under that card.
  String? _accountNotice;
  bool _accountNoticeIsError = false;

  @override
  void initState() {
    super.initState();
    // `arm()` is the documented place to bring the Android foreground service
    // back after the OS killed it; the Home dashboard and the wake-word screen
    // both do this. No MediaQuery here.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(wakeWordStateProvider.notifier).arm();
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final wake = ref.watch(wakeWordStateProvider);

    return NovaScaffold(
      topBar: Row(
        children: [
          NovaIconButton(
            icon: Icons.arrow_back_rounded,
            tooltip: 'Back',
            onTap: () => context.pop(),
          ),
          const SizedBox(width: NovaSpace.xs),
          Expanded(
            child: Text(
              'Wake word',
              style: NovaTheme.heroName(c).copyWith(fontSize: 22),
            ),
          ),
        ],
      ),
      refresh: () async {
        ref.invalidate(wakeWordConfigProvider);
        await ref.read(wakeWordStateProvider.notifier).refreshAvailability();
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const NovaSectionHeader(title: 'On this device'),
          const SizedBox(height: NovaSpace.xs),
          _ListeningCard(
            wake: wake,
            onOpenControls: () => context.push('/wakeword'),
          ),
          const SizedBox(height: NovaSpace.md),
          if (wake.availability == null)
            const NovaCard(
              child: SizedBox(
                height: 56,
                child: Center(child: CircularProgressIndicator()),
              ),
            )
          else if (!wake.isSupported)
            _UnavailableCard(wake: wake)
          else if (!wake.hasChoice)
            _SingleModelCard(wake: wake, busy: _busy, onRecheck: _refresh)
          else
            _ModelChoices(
              wake: wake,
              busy: _busy,
              onSelect: _select,
            ),
          if (wake.error != null) ...[
            const SizedBox(height: NovaSpace.md),
            _ErrorLine(message: wake.error!),
          ],
          const SizedBox(height: NovaSpace.lg),

          const NovaSectionHeader(title: 'On your account'),
          const SizedBox(height: NovaSpace.xs),
          _AccountRecordCard(
            wake: wake,
            busy: _busy,
            notice: _accountNotice,
            noticeIsError: _accountNoticeIsError,
            onRecord: wake.selectedModel == null
                ? null
                : () => _record(wake.selectedModel!, wake.installedModels),
            onRetry: () {
              setState(() {
                _accountNotice = null;
                _accountNoticeIsError = false;
              });
              ref.invalidate(wakeWordConfigProvider);
            },
          ),
          const SizedBox(height: NovaSpace.lg),

          const NovaSectionHeader(title: 'What a wake word can and cannot do'),
          const SizedBox(height: NovaSpace.xs),
          const _LimitsCard(),
          const SizedBox(height: NovaSpace.xxl),
        ],
      ),
    );
  }

  Future<void> _refresh() async {
    await ref.read(wakeWordStateProvider.notifier).refreshAvailability();
  }

  /// Applies [name] on the device, then records the choice against the account.
  ///
  /// The device is the authority: when the native service refuses the name the
  /// server is not called at all, so the account record can never name a phrase
  /// this device rejected.
  Future<void> _select(String name) async {
    setState(() {
      _busy = true;
      _accountNotice = null;
      _accountNoticeIsError = false;
    });

    final controller = ref.read(wakeWordStateProvider.notifier);
    final applied = await controller.setModel(name);
    if (!mounted) return;

    setState(() => _busy = false);
    if (!applied) return;

    final installed = ref.read(wakeWordStateProvider).installedModels;
    await _record(name, installed);
  }

  Future<void> _record(String wakeWord, List<String> available) async {
    if (!mounted) return;
    setState(() {
      _accountNotice = null;
      _accountNoticeIsError = false;
    });

    try {
      await ref.read(novaApiProvider).updateWakeWordConfig(
            wakeWord: wakeWord,
            available: available,
          );
      if (!mounted) return;
      // Re-read rather than trusting the echo, so the card shows the record the
      // server actually holds.
      ref.invalidate(wakeWordConfigProvider);
      setState(() => _accountNotice = 'Recorded on your account.');
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _accountNoticeIsError = true;
        // The device choice stands regardless; only the account note failed.
        _accountNotice =
            'This device will use "${humanizeWakeWordName(wakeWord)}", but the '
            'account record could not be saved: ${_describe(error)}';
      });
    }
  }

  static String _describe(Object error) => error
      .toString()
      .replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '')
      .trim();
}

/// What the microphone is listening for, straight from the native service.
class _ListeningCard extends StatelessWidget {
  const _ListeningCard({required this.wake, required this.onOpenControls});

  final WakeWordState wake;
  final VoidCallback onOpenControls;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final theme = Theme.of(context).textTheme;
    final phrase = wake.phrase;
    final selected = wake.selectedModel;
    final status = !wake.isSupported
        ? 'Unavailable on this build'
        : wake.listening
        ? 'Listening now'
        : wake.enabled
        ? 'Paused'
        : 'Off';

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('LISTENING FOR', style: NovaTheme.overline(c)),
          const SizedBox(height: NovaSpace.xxs),
          Text(
            // No phrase is invented when nothing is installed: the card drops
            // the quotation rather than naming a word the app cannot hear.
            phrase == null ? 'Nothing — no wake word is installed' : '"$phrase"',
            style: phrase == null
                ? theme.titleMedium!.copyWith(color: c.muted)
                : NovaTheme.heroName(c).copyWith(fontSize: 26),
          ),
          if (selected != null) ...[
            const SizedBox(height: NovaSpace.xxs),
            Text(
              'Classifier "$selected" · detected on device by openWakeWord',
              style: theme.bodySmall,
            ),
          ],
          const SizedBox(height: NovaSpace.sm),
          Row(
            children: [
              Icon(
                wake.listening
                    ? Icons.graphic_eq_rounded
                    : Icons.pause_circle_outline_rounded,
                size: 14,
                color: wake.listening ? c.success : c.muted,
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  status,
                  style: theme.bodySmall!.copyWith(
                    color: wake.listening ? c.success : c.muted,
                  ),
                ),
              ),
              NovaSecondaryButton(
                label: 'Listening controls',
                icon: Icons.tune_rounded,
                onPressed: onOpenControls,
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// Shown when the native service reports no usable classifier or no support.
class _UnavailableCard extends ConsumerWidget {
  const _UnavailableCard({required this.wake});

  final WakeWordState wake;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context).textTheme;
    final availability = wake.availability!;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Wake word detection is unavailable', style: theme.titleMedium),
          const SizedBox(height: NovaSpace.xxs),
          Text(availability.userMessage, style: theme.bodySmall),
          const SizedBox(height: NovaSpace.sm),
          NovaSecondaryButton(
            label: 'Re-check',
            icon: Icons.refresh_rounded,
            onPressed: () =>
                ref.read(wakeWordStateProvider.notifier).refreshAvailability(),
          ),
        ],
      ),
    );
  }
}

/// The honest single-classifier case — which is the shipped build.
class _SingleModelCard extends StatelessWidget {
  const _SingleModelCard({
    required this.wake,
    required this.busy,
    required this.onRecheck,
  });

  final WakeWordState wake;
  final bool busy;
  final Future<void> Function() onRecheck;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final theme = Theme.of(context).textTheme;
    final only = wake.installedModels.length == 1
        ? wake.installedModels.first
        : null;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.info_outline_rounded, size: 16, color: c.warning),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'Only one wake word is installed',
                  style: theme.titleMedium,
                ),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          Text(
            only == null
                ? 'This build installs a single on-device classifier, so there is '
                      'nothing to choose between and no picker is shown.'
                : 'This build installs one on-device classifier, "$only". There is '
                      'nothing to choose between, so NOVA does not show a picker whose '
                      'only option is the phrase it already uses.',
            style: theme.bodySmall,
          ),
          const SizedBox(height: NovaSpace.sm),
          Text(
            'Switching to a different phrase — including a real "Hey Nova" — means '
            'adding another openWakeWord classifier to the app bundle: an .onnx file '
            'listed in android/app/src/main/assets/wakeword/models.json. No such '
            'model exists in this repository, and this screen will not pretend one '
            'does.',
            style: theme.bodySmall,
          ),
          const SizedBox(height: NovaSpace.sm),
          Wrap(
            spacing: NovaSpace.xs,
            runSpacing: NovaSpace.xs,
            children: [
              NovaSecondaryButton(
                label: busy ? 'Working…' : 'Re-check installed models',
                icon: Icons.refresh_rounded,
                onPressed: busy ? null : () => onRecheck(),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

/// The real picker, shown only when more than one classifier is installed.
class _ModelChoices extends StatelessWidget {
  const _ModelChoices({
    required this.wake,
    required this.busy,
    required this.onSelect,
  });

  final WakeWordState wake;
  final bool busy;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final selected = wake.selectedModel;

    return NovaCard(
      padding: EdgeInsets.zero,
      child: Column(
        children: [
          for (var i = 0; i < wake.installedModels.length; i++) ...[
            if (i > 0) Divider(height: 1, color: c.border),
            NovaListRow(
              title: humanizeWakeWordName(wake.installedModels[i]),
              subtitle: wake.installedModels[i] == selected
                  ? 'Listening for this phrase'
                  : 'Installed on this device',
              icon: wake.installedModels[i] == selected
                  ? Icons.radio_button_checked_rounded
                  : Icons.radio_button_unchecked_rounded,
              iconTone: wake.installedModels[i] == selected
                  ? c.accent
                  : c.muted,
              onTap: busy ? null : () => onSelect(wake.installedModels[i]),
            ),
          ],
        ],
      ),
    );
  }
}

/// §13.10 — the server's record of the user's choice, and what it is not.
class _AccountRecordCard extends ConsumerWidget {
  const _AccountRecordCard({
    required this.wake,
    required this.busy,
    required this.notice,
    required this.noticeIsError,
    required this.onRecord,
    required this.onRetry,
  });

  final WakeWordState wake;
  final bool busy;
  final String? notice;
  final bool noticeIsError;
  final Future<void> Function()? onRecord;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final theme = Theme.of(context).textTheme;
    final config = ref.watch(wakeWordConfigProvider);

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          config.when(
            loading: () => const SizedBox(
              height: 48,
              child: Center(child: CircularProgressIndicator()),
            ),
            error: (Object error, _) => Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Could not read your account record',
                  style: theme.titleMedium,
                ),
                const SizedBox(height: NovaSpace.xxs),
                Text(_describe(error), style: theme.bodySmall),
                const SizedBox(height: NovaSpace.sm),
                NovaSecondaryButton(
                  label: 'Retry',
                  icon: Icons.refresh_rounded,
                  onPressed: onRetry,
                ),
              ],
            ),
            data: (Map<String, dynamic> data) => _recordBody(context, data),
          ),
          const SizedBox(height: NovaSpace.sm),
          // The caveat is rendered from our own words, not only the server's
          // `note`, so the screen still says it if the payload changes.
          Text(
            'This is a preference record. It does not change what your microphone '
            'listens for — the classifier installed in the app decides that, on this '
            'device.',
            style: theme.bodySmall,
          ),
          if (notice != null) ...[
            const SizedBox(height: NovaSpace.xs),
            Text(
              notice!,
              style: theme.bodySmall!.copyWith(
                color: noticeIsError ? c.danger : c.success,
              ),
            ),
          ],
        ],
      ),
    );
  }

  Widget _recordBody(BuildContext context, Map<String, dynamic> data) {
    final c = context.nova;
    final theme = Theme.of(context).textTheme;
    final recorded = data['wakeWord'] as String?;
    final updatedAt = data['updatedAt'] as String?;
    final devicePhrase = wake.selectedModel;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          recorded == null
              ? 'No wake word recorded yet'
              : 'Recorded: ${humanizeWakeWordName(recorded)}',
          style: theme.titleMedium,
        ),
        if (recorded != null) ...[
          const SizedBox(height: NovaSpace.xxs),
          Text(
            updatedAt == null
                ? 'Classifier "$recorded"'
                : 'Classifier "$recorded" · saved $updatedAt',
            style: theme.bodySmall,
          ),
          if (devicePhrase != null && devicePhrase != recorded) ...[
            const SizedBox(height: NovaSpace.xxs),
            Text(
              'Your account says "${humanizeWakeWordName(recorded)}" but this device '
              'listens for "${humanizeWakeWordName(devicePhrase)}". The device is what '
              'actually runs.',
              style: theme.bodySmall!.copyWith(color: c.warning),
            ),
          ],
        ],
        if (onRecord != null && recorded != devicePhrase) ...[
          const SizedBox(height: NovaSpace.sm),
          NovaSecondaryButton(
            label: busy
                ? 'Saving…'
                : 'Record "${humanizeWakeWordName(devicePhrase!)}" on my account',
            icon: Icons.cloud_upload_outlined,
            onPressed: busy ? null : () => onRecord!(),
          ),
        ],
      ],
    );
  }

  static String _describe(Object error) =>
      error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '').trim();
}

/// The wake-word path opens the conversation; it cannot run a device action.
class _LimitsCard extends StatelessWidget {
  const _LimitsCard();

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    final style = Theme.of(context).textTheme.bodySmall;

    return NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.check_circle_outline_rounded,
                size: 16,
                color: c.success,
              ),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'It opens the conversation when NOVA hears the phrase.',
                  style: style,
                ),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.xs),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                Icons.do_not_disturb_on_outlined,
                size: 16,
                color: c.danger,
              ),
              const SizedBox(width: NovaSpace.xs),
              Expanded(
                child: Text(
                  'It cannot run a device action. The wake word never opens an app, '
                  'sends a message, or changes a setting by itself.',
                  style: style,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ErrorLine extends StatelessWidget {
  const _ErrorLine({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(Icons.error_outline_rounded, size: 16, color: c.danger),
        const SizedBox(width: NovaSpace.xs),
        Expanded(
          child: Text(
            message,
            style: Theme.of(context).textTheme.bodySmall!.copyWith(color: c.danger),
          ),
        ),
      ],
    );
  }
}
