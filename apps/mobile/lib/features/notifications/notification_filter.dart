import 'notification_app_catalogue.dart';
import 'notification_content_guard.dart';
import 'notification_models.dart';

/// The canonical filter that decides whether NOVA may use a notification at all.
///
/// The order and the rules are fixed by the product brief and must not be
/// rearranged:
///
///  1. §5.21 / hard rule — master toggle off ⇒ nothing is read. No exceptions,
///     not even for the app-level checks that follow.
///  2. §5.21 "Read selected notifications" — the package must be on the user's
///     allowlist.
///  3. §5.21 "Banking apps" / "OTP / authenticator apps" ⇒ drop. This runs
///     *after* the allowlist check on purpose: a blocked package that somehow
///     ended up on the allowlist (a restored backup, a hand-edited preference
///     file, a bug in a future settings screen) is still dropped, which is what
///     "un-selectable, not merely unchecked" has to mean.
///  4. §9.5 non-negotiable — content that looks like an OTP, password,
///     verification code, bank alert or auth message is always dropped,
///     regardless of the allowlist. [NotificationContentGuard] owns the
///     patterns; this class only decides where in the order they run.
///  5. §5.21 "Summarize only high-priority work notifications" — anything else
///     is discarded rather than retained.
///
/// The filter is pure: given the same notification and settings it always
/// returns the same verdict, touches no platform channel, performs no I/O and
/// logs nothing. That is what makes every rule above directly unit-testable,
/// and it is why the read-aloud path can call it again as a last check.
///
/// The same rules are mirrored in Kotlin (`NotificationContentGuard.kt` and
/// `NovaNotificationListenerService.kt`) so that they also apply while the
/// Flutter engine is not running; that copy is a second line of defence, and
/// this one is the specification.
abstract final class NotificationFilter {
  /// `NotificationManager.IMPORTANCE_DEFAULT`: alerting, not heads-up.
  static const int alertingImportance = 3;

  /// `NotificationManager.IMPORTANCE_HIGH`: heads-up.
  static const int highImportance = 4;

  /// Categories that describe work-shaped traffic. Android's own constants:
  /// `CATEGORY_EMAIL`, `CATEGORY_EVENT`, `CATEGORY_MESSAGE`, `CATEGORY_CALL`,
  /// `CATEGORY_REMINDER`, `CATEGORY_PROGRESS`.
  static const Set<String> workCategories = <String>{
    'email',
    'event',
    'msg',
    'call',
    'reminder',
    'progress',
  };

  /// Categories that are never work, at any importance. `promo` and `social`
  /// are Android's own; the rest are the categories that describe the device
  /// rather than a person.
  static const Set<String> nonWorkCategories = <String>{
    'promo',
    'social',
    'recommendation',
    'transport',
    'navigation',
    'location_sharing',
    'system',
    'service',
    'status',
    'error',
    'alarm',
    'insurance',
    'travel',
    'missed_call',
  };

  /// Applies the five rules in order and returns the verdict.
  static NotificationDecision evaluate({
    required CapturedNotification notification,
    required NotificationGuardSettings settings,
  }) {
    // 1. Master toggle.
    if (!settings.enabled) {
      return const NotificationDropped(NotificationDropReason.masterDisabled);
    }

    // 2. Allowlist.
    if (!settings.allowedPackages.contains(notification.packageName)) {
      return const NotificationDropped(
        NotificationDropReason.packageNotAllowed,
      );
    }

    // 3. Blocklist, including the built-in banking / OTP / password categories.
    final blocked = blockedCategoryFor(
      notification.packageName,
      appLabel: notification.appLabel,
    );
    if (blocked != null || settings.effectiveBlockedPackages.contains(
      notification.packageName,
    )) {
      return NotificationDropped(
        NotificationDropReason.packageBlocked,
        detail: blocked?.name ?? 'user_blocked',
      );
    }

    // 4. Never-touch content, whatever the allowlist says.
    final sensitive = NotificationContentGuard.detect(
      title: notification.title,
      body: notification.body,
    );
    if (sensitive != null) {
      return NotificationDropped(
        NotificationDropReason.sensitiveContent,
        detail: sensitive.name,
      );
    }

    // 5. Only high-priority work notifications are worth summarising.
    if (settings.summarizeHighPriorityOnly &&
        !isHighPriorityWork(notification)) {
      return NotificationDropped(
        NotificationDropReason.notHighPriorityWork,
        detail: notification.category,
      );
    }

    return NotificationAllowed(
      UntrustedNotificationData.from(notification),
    );
  }

  /// §5.21 "Summarize only high-priority work notifications".
  ///
  /// The rule, in plain terms:
  ///  * a silent notification (`IMPORTANCE_LOW`/`MIN`/`NONE`) is never
  ///    high-priority, whatever it says;
  ///  * a category Android marks as promotional, social or system is never
  ///    work, whatever its importance;
  ///  * a declared work category is accepted at `IMPORTANCE_DEFAULT` or above,
  ///    because that is what an alerting Gmail or Calendar notification
  ///    actually uses;
  ///  * with no category to reason about, only a heads-up notification
  ///    (`IMPORTANCE_HIGH` or `MAX`) qualifies.
  ///
  /// `IMPORTANCE_UNSPECIFIED` (−1000) is normalised to 0 by the native layer,
  /// so an app that sets neither category nor importance is dropped rather than
  /// assumed important.
  static bool isHighPriorityWork(CapturedNotification notification) {
    final importance = notification.importance;
    if (importance < alertingImportance) return false;

    final category = notification.category?.trim().toLowerCase();
    if (category == null || category.isEmpty) {
      return importance >= highImportance;
    }
    if (nonWorkCategories.contains(category)) return false;
    if (workCategories.contains(category)) return true;
    return importance >= highImportance;
  }
}
