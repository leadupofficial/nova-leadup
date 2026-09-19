package com.leadup.nova

import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.session.MediaSessionManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import android.view.KeyEvent
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * NOVA's device & system control surface (product brief §9.2).
 *
 * The decisions — permission levels, what Android permits, the intent each
 * action uses, the wording of every refusal — live in [DeviceControlCatalog],
 * which is Android-free and unit-tested on a JVM. This class is the thin half
 * that touches the platform: it turns a [DeviceControlCatalog.IntentSpec] into a
 * real `Intent`, calls `AudioManager`, and reads the two special accesses.
 *
 * ## Every branch answers honestly
 *
 * Each method returns a map shaped `{ ok, code, message, … }`. There is no
 * silent no-op and no false success:
 *
 *  * an action Android cannot perform returns `unsupported` — never `ok:true`;
 *  * a special access the user has not granted returns `permission_denied` plus
 *    the panel that grants it, and **the action is not attempted**;
 *  * media transport, whose outcome a third-party app cannot fully confirm,
 *    refuses to send a key when no media session is detectable and says so with
 *    `no_active_session`.
 *
 * The channels are wired from `MainActivity.configureFlutterEngine`, the same
 * lifetime pattern as `WakeWordService` and `NovaNotificationListenerService`.
 */
class NovaDeviceControl private constructor(private val context: Context) {

    companion object {
        const val TAG = "NovaDeviceControl"
        const val METHOD_CHANNEL_NAME = "nova/device_control"

        // Result codes. Frozen: Dart maps these to its own enum, and a test on
        // each side pins the list.
        const val CODE_OK = "ok"
        const val CODE_UNSUPPORTED = "unsupported"
        const val CODE_PERMISSION_DENIED = "permission_denied"
        const val CODE_APP_NOT_FOUND = "app_not_found"
        const val CODE_NO_ACTIVE_SESSION = "no_active_session"
        const val CODE_INVALID_ARGUMENT = "invalid_argument"
        const val CODE_FAILED = "failed"

        fun registerChannels(messenger: BinaryMessenger, context: Context) {
            val control = NovaDeviceControl(context.applicationContext)
            MethodChannel(messenger, METHOD_CHANNEL_NAME)
                .setMethodCallHandler(control::onMethodCall)
        }
    }

    private val packageManager get() = context.packageManager
    private val audioManager
        get() = context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
    private val notificationManager
        get() = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

    private fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "status" -> result.success(status())

                "openApp" -> result.success(openApp(stringArg(call, "app")))

                "openDeepLink" -> result.success(openDeepLink(stringArg(call, "uri")))

                "openSettings" -> result.success(openSettings(stringArg(call, "panel")))

                "dial" -> result.success(dial(stringArg(call, "number")))

                "setBrightness" -> result.success(setBrightness(doubleArg(call, "value")))

                "getBrightness" -> result.success(getBrightness())

                "setDnd" -> result.success(setDnd(boolArg(call, "enabled")))

                "getDnd" -> result.success(getDnd())

                "media" -> result.success(media(stringArg(call, "action")))

                // Meeting capture is done by the Flutter recorder (§5.11), not
                // by Android. These ids exist so the three registries agree;
                // if one is ever sent here, say so honestly rather than
                // reporting a success for an intent that does not exist.
                "startRecording", "stopRecording" -> result.success(
                    failure(
                        CODE_UNSUPPORTED,
                        "Meeting recording is performed by the NOVA app itself, " +
                            "not by an Android action. Nothing was changed on the device.",
                    ),
                )

                else -> result.notImplemented()
            }
        } catch (t: Throwable) {
            // A crash here would take the Flutter engine's channel down. Any
            // unexpected platform failure is reported as a failure, never as a
            // silent success.
            Log.w(TAG, "Device control call ${call.method} failed", t)
            result.success(
                failure(CODE_FAILED, "Android refused ${call.method}: ${t.message ?: t::class.java.simpleName}"),
            )
        }
    }

    // ─── Status ───────────────────────────────────────────────────────────

    /**
     * What this device and this grant state allow.
     *
     * The screen renders this verbatim, which is why the reasons are prose
     * rather than codes: a capability that is impossible must explain *why* it
     * is impossible, not just be absent.
     */
    private fun status(): Map<String, Any?> {
        val writeSettings = canWriteSettings()
        val dndAccess = hasDndAccess()

        val actions = DeviceControlCatalog.Action.entries.map { action ->
            val granted = when (action) {
                DeviceControlCatalog.Action.SET_BRIGHTNESS -> writeSettings
                DeviceControlCatalog.Action.SET_DND -> dndAccess
                else -> true
            }
            mapOf(
                "action" to action.wireName,
                "level" to DeviceControlCatalog.levelOf(action),
                "capability" to DeviceControlCatalog.capabilityOf(action).name.lowercase(),
                "available" to true,
                "granted" to granted,
                "reason" to if (granted) null else DeviceControlCatalog.grantReason(action),
            )
        // Meeting capture is executed in Dart, so it is not an Android
        // capability and is not reported as one.
        }.filter {
            (it["capability"] as String) !=
                DeviceControlCatalog.Capability.DART_EXECUTED.name.lowercase()
        }

        val panels = DeviceControlCatalog.SettingsPanel.entries.map { panel ->
            mapOf(
                "panel" to panel.wireName,
                "capability" to DeviceControlCatalog.panelCapability(panel).name.lowercase(),
                "available" to true,
                "granted" to true,
                "reason" to if (
                    DeviceControlCatalog.panelCapability(panel) ==
                    DeviceControlCatalog.Capability.DEEP_LINK_ONLY
                ) {
                    DeviceControlCatalog.deepLinkReason(panel)
                } else {
                    null
                },
            )
        }

        val excluded = DeviceControlCatalog.EXCLUDED.map { item ->
            mapOf("id" to item.id, "title" to item.title, "reason" to item.reason)
        }

        return mapOf(
            "supported" to true,
            "androidSdk" to Build.VERSION.SDK_INT,
            "androidRelease" to Build.VERSION.RELEASE,
            "confirmLevel" to DeviceControlCatalog.DEFAULT_CONFIRM_LEVEL,
            "actions" to actions,
            "panels" to panels,
            "excluded" to excluded,
            "brightness" to getBrightness(),
            "dndEnabled" to getDnd(),
        )
    }

    // ─── Actions ──────────────────────────────────────────────────────────

    private fun openApp(app: String): Map<String, Any?> {
        val packageName = DeviceControlCatalog.packageForApp(app)
            ?: return failure(
                CODE_INVALID_ARGUMENT,
                "NOVA does not know an app called \"$app\". Use a package name or a name from the known list.",
            )

        val launch = try {
            packageManager.getLaunchIntentForPackage(packageName)
        } catch (t: Throwable) {
            Log.w(TAG, "Could not resolve a launch intent for $packageName", t)
            null
        } ?: return failure(
            CODE_APP_NOT_FOUND,
            "$packageName is not installed, or it has no launchable screen.",
        )

        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return startActivity(launch, "Opened $packageName.")
    }

    private fun openDeepLink(uri: String): Map<String, Any?> {
        val spec = DeviceControlCatalog.deepLinkIntentSpec(uri)
            ?: return failure(
                CODE_INVALID_ARGUMENT,
                "That link is not one NOVA will open. Use an http, https or app link.",
            )
        val intent = Intent(spec.action, Uri.parse(spec.data))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return startActivity(intent, "Opened the link.")
    }

    private fun openSettings(panel: String): Map<String, Any?> {
        val resolved = DeviceControlCatalog.panelFor(panel)
            ?: return failure(CODE_INVALID_ARGUMENT, "Unknown settings panel \"$panel\".")
        val spec = DeviceControlCatalog.settingsIntentSpec(resolved)
        val intent = Intent(spec.action)
        spec.data?.let { intent.data = Uri.parse(it) }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return startActivity(intent, "Opened the ${resolved.wireName} settings screen.", resolved)
    }

    private fun dial(number: String): Map<String, Any?> {
        val spec = DeviceControlCatalog.dialIntentSpec(number)
            ?: return failure(
                CODE_INVALID_ARGUMENT,
                "\"$number\" is not a number NOVA can put in the dialer.",
            )
        val intent = Intent(spec.action, Uri.parse(spec.data))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // ACTION_DIAL shows the number; it never places the call. §9.2 asks for
        // exactly this, and the app adds no CALL_PHONE permission.
        return startActivity(intent, "Opened the dialer with ${spec.data?.removePrefix("tel:")}.")
    }

    private fun setBrightness(value: Double): Map<String, Any?> {
        if (!canWriteSettings()) {
            return failure(
                CODE_PERMISSION_DENIED,
                DeviceControlCatalog.grantReason(DeviceControlCatalog.Action.SET_BRIGHTNESS),
                grantPanel = DeviceControlCatalog.SettingsPanel.WRITE_SETTINGS,
            )
        }
        if (value.isNaN() || value.isInfinite() || value < 0.0 || value > 1.0) {
            return failure(CODE_INVALID_ARGUMENT, "Brightness must be between 0 and 1.")
        }

        val level = DeviceControlCatalog.brightnessToSystem(value)
        val resolver = context.contentResolver
        return try {
            // Automatic brightness ignores SCREEN_BRIGHTNESS, so writing it
            // alone would report success while nothing changed. Switching the
            // mode to manual is what makes the requested brightness take effect,
            // and the result says that it happened.
            val mode = Settings.System.getInt(
                resolver,
                Settings.System.SCREEN_BRIGHTNESS_MODE,
                Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL,
            )
            val disabledAuto = mode == Settings.System.SCREEN_BRIGHTNESS_MODE_AUTOMATIC
            if (disabledAuto) {
                Settings.System.putInt(
                    resolver,
                    Settings.System.SCREEN_BRIGHTNESS_MODE,
                    Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL,
                )
            }
            Settings.System.putInt(resolver, Settings.System.SCREEN_BRIGHTNESS, level)
            success(
                message = if (disabledAuto) {
                    "Brightness set to ${(level * 100) / 255}%; automatic brightness was on, so it is now off."
                } else {
                    "Brightness set to ${(level * 100) / 255}%."
                },
                extra = mapOf("brightness" to level, "disabledAutoBrightness" to disabledAuto),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "Could not write the screen brightness", t)
            failure(CODE_FAILED, "Android refused the brightness change: ${t.message}")
        }
    }

    private fun getBrightness(): Int {
        return try {
            Settings.System.getInt(
                context.contentResolver,
                Settings.System.SCREEN_BRIGHTNESS,
                128,
            ).coerceIn(0, 255)
        } catch (t: Throwable) {
            128
        }
    }

    private fun setDnd(enabled: Boolean): Map<String, Any?> {
        val manager = notificationManager
            ?: return failure(CODE_UNSUPPORTED, "This device has no notification manager.")
        if (!hasDndAccess()) {
            return failure(
                CODE_PERMISSION_DENIED,
                DeviceControlCatalog.grantReason(DeviceControlCatalog.Action.SET_DND),
                grantPanel = DeviceControlCatalog.SettingsPanel.DND_ACCESS,
            )
        }
        return try {
            val filter = DeviceControlCatalog.interruptionFilterFor(enabled)
            manager.setInterruptionFilter(filter)
            success(
                message = if (enabled) {
                    "Do Not Disturb is on."
                } else {
                    "Do Not Disturb is off."
                },
                extra = mapOf("dndEnabled" to DeviceControlCatalog.dndEnabledFor(filter)),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "Could not change the interruption filter", t)
            failure(CODE_FAILED, "Android refused the Do Not Disturb change: ${t.message}")
        }
    }

    private fun getDnd(): Boolean {
        return try {
            DeviceControlCatalog.dndEnabledFor(
                notificationManager?.currentInterruptionFilter
                    ?: DeviceControlCatalog.INTERRUPTION_FILTER_ALL,
            )
        } catch (t: Throwable) {
            false
        }
    }

    /**
     * Sends one media transport key to the active session.
     *
     * A third-party app cannot enumerate media sessions without
     * `MEDIA_CONTENT_CONTROL` (signature-level) — but NOVA holds Notification
     * Access for §5.21, and an enabled notification listener may consult
     * `MediaSessionManager`. That is tried first, then `AudioManager.isMusicActive`
     * (which stays true while a player holds the output, including while
     * paused). If neither sees a session the key is **not** sent and the caller
     * gets `no_active_session`, because dispatching into nothing would report a
     * success that did not happen.
     */
    private fun media(action: String): Map<String, Any?> {
        val media = DeviceControlCatalog.mediaActionFor(action)
            ?: return failure(CODE_INVALID_ARGUMENT, "Unknown media action \"$action\".")

        val sessionSource = detectSession()
        if (sessionSource == null) {
            return failure(
                CODE_NO_ACTIVE_SESSION,
                "No media session is active, so nothing was sent. Start playback first.",
            )
        }

        val manager = audioManager
            ?: return failure(CODE_UNSUPPORTED, "This device has no audio manager.")

        return try {
            val down = KeyEvent(KeyEvent.ACTION_DOWN, media.keyCode)
            val up = KeyEvent(KeyEvent.ACTION_UP, media.keyCode)
            manager.dispatchMediaKeyEvent(down)
            manager.dispatchMediaKeyEvent(up)
            success(
                message = "Sent ${media.wireName} to the active media session.",
                extra = mapOf("mediaAction" to media.wireName, "sessionSource" to sessionSource),
            )
        } catch (t: Throwable) {
            Log.w(TAG, "Could not dispatch a media key", t)
            failure(CODE_FAILED, "Android refused the media key: ${t.message}")
        }
    }

    /**
     * Where an active media session was seen, or null when none was.
     *
     * `"session_manager"` is the reliable answer; `"audio_manager"` is the
     * fallback heuristic; null means neither found one.
     */
    private fun detectSession(): String? {
        try {
            val sessions = context.getSystemService(Context.MEDIA_SESSION_SERVICE)
                ?.let { it as? MediaSessionManager }
                ?.getActiveSessions(
                    ComponentName(context, NovaNotificationListenerService::class.java),
                )
            if (!sessions.isNullOrEmpty()) return "session_manager"
        } catch (t: Throwable) {
            // SecurityException when Notification Access is not granted. Not an
            // error: the fallback below is the normal path in that case.
            Log.d(TAG, "Active-session lookup unavailable: ${t.message}")
        }
        return if (audioManager?.isMusicActive == true) "audio_manager" else null
    }

    // ─── Helpers ──────────────────────────────────────────────────────────

    private fun canWriteSettings(): Boolean = try {
        Settings.System.canWrite(context)
    } catch (t: Throwable) {
        false
    }

    private fun hasDndAccess(): Boolean = try {
        notificationManager?.isNotificationPolicyAccessGranted == true
    } catch (t: Throwable) {
        false
    }

    private fun startActivity(
        intent: Intent,
        message: String,
        panel: DeviceControlCatalog.SettingsPanel? = null,
    ): Map<String, Any?> = try {
        context.startActivity(intent)
        success(message, extra = panel?.let { mapOf("panel" to it.wireName) } ?: emptyMap())
    } catch (notFound: ActivityNotFoundException) {
        failure(
            CODE_UNSUPPORTED,
            "This device has no screen for that action, so nothing was opened.",
        )
    } catch (t: Throwable) {
        Log.w(TAG, "Could not start an activity", t)
        failure(CODE_FAILED, "Android refused to open that: ${t.message}")
    }

    private fun success(
        message: String,
        extra: Map<String, Any?> = emptyMap(),
    ): Map<String, Any?> = mapOf(
        "ok" to true,
        "code" to CODE_OK,
        "message" to message,
    ) + extra

    private fun failure(
        code: String,
        message: String,
        grantPanel: DeviceControlCatalog.SettingsPanel? = null,
    ): Map<String, Any?> = mapOf(
        "ok" to false,
        "code" to code,
        "message" to message,
        "grantPanel" to grantPanel?.wireName,
    )

    private fun stringArg(call: MethodCall, name: String): String =
        call.argument<String>(name)?.trim().orEmpty()

    private fun doubleArg(call: MethodCall, name: String): Double =
        call.argument<Double>(name) ?: Double.NaN

    private fun boolArg(call: MethodCall, name: String): Boolean =
        call.argument<Boolean>(name) ?: false
}
