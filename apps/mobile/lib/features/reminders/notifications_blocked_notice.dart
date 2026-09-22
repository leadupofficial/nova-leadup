import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

import '../../core/design/widgets/index.dart';
import 'reminder_notifications.dart';

/// "Android is not letting NOVA notify you, so your reminders cannot reach you."
///
/// ## The defect this exists for
///
/// `POST_NOTIFICATIONS` was declared and requested once from onboarding, and the
/// **wake word** path correctly refused and named it. The **reminder** path never
/// checked it: its only gate was Profile → Notifications, which is a different
/// thing entirely. So a user who declined the OS dialog at onboarding — or
/// revoked it later in Android settings — had every reminder silently discarded.
///
/// Measured on the OnePlus 9R with the screen locked and dozing: the alarm was
/// armed and verified in `AlarmManager` (`RTC_WAKEUP #5 … ScheduledNotificationReceiver`,
/// `origWhen=2026-09-21 15:59:16`), the reminder came due at `10:29:16Z`, and
/// `dumpsys notification | grep pkg=com.leadup.nova` returned **nothing** while
/// polling every 20s through `10:30:13Z`. Meanwhile the reconciler kept reporting
/// `scheduled: N`, and there was no copy anywhere in the app that said
/// notifications were off.
///
/// ## What it says, and why in these words
///
/// "Your reminders cannot reach you" is the consequence, not the mechanism. A
/// user does not know what `POST_NOTIFICATIONS` is and does not need to: they need
/// to know that the thing they asked for is not happening and which switch fixes
/// it. The button opens Android's per-app notification page, because a
/// *permanently* denied runtime permission cannot be re-granted from a dialog —
/// only from Settings.
///
/// It is deliberately not a blocking prompt and not an OS dialog: it is a card the
/// user can ignore, exactly like the exact-alarm disclosure beside it.
class NotificationsBlockedNotice extends ConsumerWidget {
  const NotificationsBlockedNotice({
    super.key,
    this.title = 'Notifications are off, so reminders cannot reach you',
    this.margin,
  });

  /// Handle the tests read the card by.
  static const Key cardKey = Key('notifications-blocked-notice');

  final String title;

  /// Applied around the card. `NovaCard` has no margin of its own, so callers
  /// that stack cards pass their own spacing here.
  final EdgeInsetsGeometry? margin;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.nova;
    final card = NovaCard(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.notifications_off_rounded,
                size: 18,
                color: c.warning,
              ),
              const SizedBox(width: NovaSpace.sm),
              Expanded(
                child: Text(
                  title,
                  style: NovaTheme.sectionHeading(c).copyWith(fontSize: 15),
                ),
              ),
            ],
          ),
          const SizedBox(height: NovaSpace.sm),
          Text(
            'Android is blocking NOVA\'s notifications, so a reminder is armed but '
            'never shown. Nothing is lost — turn notifications back on and they '
            'arrive again.',
            style: TextStyle(
              color: c.muted,
              fontSize: NovaType.bodySmall,
              height: 1.45,
            ),
          ),
          const SizedBox(height: NovaSpace.md),
          NovaPrimaryButton(
            label: 'Open notification settings',
            onPressed: () async {
              // The system screen is the only place a permanently denied
              // permission can be re-granted. If Android refuses to open it, fall
              // back to the app's own settings page rather than doing nothing.
              final opened = await ref
                  .read(reminderNotificationsProvider)
                  .openNotificationSettings();
              if (!opened) {
                await ph.openAppSettings();
              }
            },
          ),
        ],
      ),
    );

    // Keyed on the card's own subtree, not on NovaCard, so a test can read the
    // rendered rectangle of the warning without depending on card internals.
    return Padding(
      key: cardKey,
      padding: margin ?? EdgeInsets.zero,
      child: card,
    );
  }
}
