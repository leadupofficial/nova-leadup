package com.leadup.nova

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.util.Log
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

/**
 * Opens Android's **per-app notification settings** screen.
 *
 * ## Why this exists
 *
 * `POST_NOTIFICATIONS` is declared and requested once from onboarding, but the
 * reminder path never checked it. A user who declined the OS dialog — or revoked
 * it later in Android settings — had every reminder silently discarded:
 * `AlarmManager` still held the alarm, the reconciler still reported
 * `scheduled: N`, and at delivery time Android dropped the notification without a
 * word to anyone. Measured on the OnePlus 9R with the screen dozing:
 * `dumpsys notification | grep pkg=com.leadup.nova` stayed empty through polling
 * every 20s while the alarm sat armed in `dumpsys alarm`.
 *
 * Saying so is only half a fix; the user has to be able to act on it. They cannot
 * re-grant a *permanently* denied runtime permission from an in-app dialog, so the
 * warning card routes here.
 *
 * ## Why a channel of its own
 *
 * `NovaNotificationListenerService` already opens a system screen, but a
 * different one: `ACTION_NOTIFICATION_LISTENER_SETTINGS` is **Notification
 * Access**, which this app does not need in order to post its own reminders. Two
 * unrelated grants must not share one entry point, and the reminder feature must
 * not depend on the notification-listener feature to explain itself.
 *
 * `ACTION_APP_NOTIFICATION_SETTINGS` is the modern, direct route (API 26+). The
 * two legacy extras it replaced are still attached because some OEM builds on
 * API 26–27 read only those; passing both is what makes this work on the
 * OnePlus's ColorOS as well as on AOSP.
 */
object NovaNotificationSettings {

    private const val METHOD_CHANNEL_NAME = "nova/notification_settings"
    private const val TAG = "NovaNotificationSettings"

    /** Dart-side counterpart: `features/reminders/reminder_notifications.dart`. */
    fun registerChannels(messenger: BinaryMessenger, context: Context) {
        val appContext = context.applicationContext

        MethodChannel(messenger, METHOD_CHANNEL_NAME)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "openNotificationSettings" ->
                        result.success(openNotificationSettings(appContext))

                    else -> result.notImplemented()
                }
            }
    }

    /**
     * Answers whether a screen actually opened, so Dart can fall back to the
     * app's own settings page instead of claiming to have done something.
     */
    fun openNotificationSettings(context: Context): Boolean {
        val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

        // Pre-API-26 keys. Harmless on newer devices; the only keys some OEM
        // builds read on the versions where they are still meaningful.
        intent.putExtra("app_package", context.packageName)
        intent.putExtra("app_uid", context.applicationInfo.uid)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // The channel the reminders actually post to, so the user lands on
            // the switch that matters rather than a generic list.
            intent.putExtra(
                Settings.EXTRA_CHANNEL_ID,
                FlutterLocalReminderChannel.ID,
            )
        }

        return try {
            context.startActivity(intent)
            true
        } catch (t: Throwable) {
            Log.w(TAG, "Could not open per-app notification settings", t)
            false
        }
    }
}

/**
 * The channel id `FlutterLocalReminderNotifications` creates
 * (`features/reminders/reminder_notifications.dart`).
 *
 * Duplicated rather than read from the plugin, because the plugin's channel
 * registry is not reachable from here and a wrong id only changes which screen
 * section is focused.
 */
internal object FlutterLocalReminderChannel {
    const val ID = "nova_reminders"
}
