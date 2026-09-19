package com.leadup.nova

import android.app.Notification
import android.app.NotificationManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationManagerCompat
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.Collections

/**
 * NOVA's Smart Notification Assistant listener (§5.21).
 *
 * ## Why this class exists
 *
 * It replaces `NotificationListener.kt`, a `BroadcastReceiver` for the custom
 * action `nova.notification.POSTED` that nothing in the app ever sent. A
 * receiver cannot read system notifications at all: only a
 * `NotificationListenerService` the user has explicitly enabled in Android's
 * Notification Access screen can. The receiver has been deleted.
 *
 * ## The filter, and where it runs
 *
 * A notification is dropped here, before any of its text is put on the Flutter
 * event channel, if any of the following holds:
 *
 *  1. the master toggle is off (nothing is read, not even the extras bundle);
 *  2. the posting package is in a permanently blocked category — banking,
 *     payment, OTP/authenticator or password apps;
 *  3. the package is on the user's own blocklist;
 *  4. the package is not on the user's allowlist;
 *  5. the content looks like an OTP, password, verification code, bank alert or
 *     auth message ([NotificationContentGuard]);
 *  6. the notification is a group summary, which only repeats its children.
 *
 * Rules 1-3 and 5 also run in Dart, which is the specification and is covered
 * by unit tests; these two layers are independent, and either one rejecting a
 * notification is enough.
 *
 * ## Never store, never log content
 *
 * Nothing in this class writes application state. The only persistent reads are
 * the user's settings from `SharedPreferences`; the only persistent state the
 * listener owns is the process-local set of package names it has already
 * reported. No title or body is ever written to disk, to a log, or to a
 * preference. The one log line in [onNotificationPosted] names a package and
 * nothing else. If Dart is not listening, the notification is **dropped** —
 * never buffered — because buffering would mean storing raw text.
 *
 * ## Off by default
 *
 * A fresh install has `KEY_ENABLED` false, so this service does nothing even if
 * the user granted Notification Access for some other reason. The grant alone
 * is not consent to be read.
 */
class NovaNotificationListenerService : NotificationListenerService() {

    companion object {
        const val TAG = "NovaNotificationListener"

        const val METHOD_CHANNEL_NAME = "nova/notifications"
        const val EVENT_CHANNEL_NAME = "nova/notifications/events"

        /** `shared_preferences` persists here and prefixes keys with `flutter.`. */
        const val PREFS_NAME = "FlutterSharedPreferences"
        const val KEY_ENABLED = "flutter.nova_notification_assistant_enabled"
        const val KEY_ALLOWED = "flutter.nova_notification_allowed_packages"
        const val KEY_BLOCKED = "flutter.nova_notification_blocked_packages"

        @Volatile
        private var eventSink: EventChannel.EventSink? = null

        @Volatile
        private var connected = false

        /** Package names already reported, so the UI is not spammed. */
        private val reportedPackages: MutableSet<String> =
            Collections.synchronizedSet(mutableSetOf())

        /**
         * Wires the Dart-facing channels. Called from
         * `MainActivity.configureFlutterEngine`, so the channels live as long as
         * the Flutter engine does — the same shape as `WakeWordService`.
         */
        fun registerChannels(messenger: BinaryMessenger, context: Context) {
            val appContext = context.applicationContext

            MethodChannel(messenger, METHOD_CHANNEL_NAME)
                .setMethodCallHandler { call, result ->
                    when (call.method) {
                        "status" -> result.success(status(appContext))

                        // The grant lives in Android Settings and only the user can
                        // change it. NOVA can open the screen and nothing more.
                        "openAccessSettings" -> result.success(
                            openAccessSettings(appContext),
                        )

                        else -> result.notImplemented()
                    }
                }

            EventChannel(messenger, EVENT_CHANNEL_NAME).setStreamHandler(
                object : EventChannel.StreamHandler {
                    override fun onListen(arguments: Any?, sink: EventChannel.EventSink?) {
                        eventSink = sink
                    }

                    override fun onCancel(arguments: Any?) {
                        eventSink = null
                    }
                },
            )
        }

        /** Whether Notification Access is granted, and whether the service is bound. */
        fun status(context: Context): Map<String, Any?> {
            val granted = try {
                NotificationManagerCompat.getEnabledListenerPackages(context)
                    .contains(context.packageName)
            } catch (t: Throwable) {
                Log.w(TAG, "Could not read the enabled-listener set", t)
                false
            }
            return mapOf(
                "supported" to true,
                "accessGranted" to granted,
                "connected" to connected,
                "detail" to null,
            )
        }

        private fun openAccessSettings(context: Context): Boolean {
            return try {
                context.startActivity(
                    Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
                true
            } catch (t: Throwable) {
                Log.w(TAG, "Could not open Notification Access settings", t)
                false
            }
        }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        connected = true
        Log.i(TAG, "Notification listener connected")
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        connected = false
        // The system kills and rebinds listeners; `requestRebind` is the
        // documented recovery, and without it the service can stay dead until
        // the device restarts.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            try {
                requestRebind(ComponentName(this, NovaNotificationListenerService::class.java))
            } catch (t: Throwable) {
                Log.w(TAG, "Could not request a rebind", t)
            }
        }
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val posted = sbn ?: return

        // Reading our own notifications back would be a loop, and NOVA has
        // nothing to say to itself.
        if (posted.packageName == packageName) return

        // 1. Master toggle. Off means off: the extras bundle is never touched.
        val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_ENABLED, false)) return

        val label = appLabel(posted.packageName)

        // 2. Permanently blocked categories.
        if (NotificationContentGuard.blockedCategoryFor(posted.packageName, label) != null) {
            return
        }

        // 3. The user's own blocklist.
        val blocked = prefs.getStringSet(KEY_BLOCKED, emptySet()) ?: emptySet()
        if (blocked.contains(posted.packageName)) return

        // 6. Group summaries only repeat their children. Checked before the
        //    content is read.
        if (posted.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return

        // Package name and label only — no content. This is what lets the
        // settings screen offer an app the user has not allowed yet, and it is
        // reported only from here on, i.e. only for apps that already passed
        // the blocklist.
        reportSeen(posted.packageName, label)

        // 4. Allowlist. When the app is not allowed, execution stops here and
        //    the notification text was never read out of the extras bundle.
        val allowed = prefs.getStringSet(KEY_ALLOWED, emptySet()) ?: emptySet()
        if (!allowed.contains(posted.packageName)) return

        val extras = posted.notification.extras
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val body = (
            extras.getCharSequence(Notification.EXTRA_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
                ?: extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT)
            )?.toString().orEmpty()

        // 5. Never-touch content, whatever the allowlist says. This is the §9.5
        //    non-negotiable and it runs before the text reaches the channel.
        if (NotificationContentGuard.detect(title, body) != null) {
            // Package name only. The inspected text is never logged.
            Log.i(TAG, "Dropped a sensitive notification from ${posted.packageName}")
            return
        }

        // Dart is not listening: drop. Buffering would mean storing raw text,
        // which this feature must never do.
        val sink = eventSink ?: return
        sink.success(
            mapOf(
                "type" to "notification",
                "package" to posted.packageName,
                "label" to label,
                "title" to title,
                "body" to body,
                "importance" to importanceOf(posted),
                "category" to posted.notification.category,
                "ts" to posted.postTime,
            ),
        )
    }

    /** Package name and label only. Never content. */
    private fun reportSeen(packageName: String, label: String) {
        if (!reportedPackages.add(packageName)) return
        val sink = eventSink
        if (sink == null) {
            // Nothing is listening; forget it so a later session can report it.
            reportedPackages.remove(packageName)
            return
        }
        sink.success(mapOf("type" to "app_seen", "package" to packageName, "label" to label))
    }

    /**
     * `NotificationManager.IMPORTANCE_*` for the notification.
     *
     * Channel importance is the modern source; `Notification.priority` is the
     * pre-O fallback. `IMPORTANCE_UNSPECIFIED` (-1000) and any other negative
     * value are normalised to 0 so Dart's "is this high priority" rule cannot
     * be fooled by an unspecified value.
     */
    @Suppress("DEPRECATION")
    private fun importanceOf(sbn: StatusBarNotification): Int {
        val notification = sbn.notification
        val channelImportance = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notification.channelId?.let { channelId ->
                (getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager)
                    ?.getNotificationChannel(channelId)
                    ?.importance
            }
        } else {
            null
        }
        val raw = channelImportance ?: notification.priority
        return if (raw < 0) 0 else raw
    }

    /**
     * The installed app's own label. Taken from `PackageManager`, never from the
     * notification, so a malicious app cannot label itself "Gmail".
     */
    private fun appLabel(packageName: String): String {
        return try {
            val info = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(info).toString()
        } catch (t: Exception) {
            packageName
        }
    }
}
