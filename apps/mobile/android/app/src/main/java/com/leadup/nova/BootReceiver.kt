package com.leadup.nova

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log

/**
 * Re-arms wake-word listening after a device reboot.
 *
 * Two production constraints shape this receiver:
 *
 * 1. **The user must have opted in.** We only restart when the user previously
 *    enabled the wake word (the `nova_wake_word_enabled` flag that Flutter stores
 *    through `shared_preferences`). Starting a microphone foreground service at boot
 *    for someone who never asked for it is both a privacy problem and a Play policy
 *    problem.
 *
 * 2. **Android 15+ forbids it.** Starting a `microphone`-type foreground service from
 *    a `BOOT_COMPLETED` receiver is disallowed from Android 15 (API 35) onwards and
 *    raises `ForegroundServiceStartNotAllowedException`. On those versions we skip the
 *    start entirely and let the wake word re-arm the next time the app is opened, so
 *    the receiver never crashes the process.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null) return
        if (intent?.action != Intent.ACTION_BOOT_COMPLETED) return

        if (!hasUserOptedIn(context)) {
            Log.d(TAG, "Boot completed but wake word is disabled by the user - not starting")
            return
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
            Log.i(
                TAG,
                "Boot completed on API ${Build.VERSION.SDK_INT}: microphone foreground services " +
                    "cannot be started from BOOT_COMPLETED. Wake word will re-arm on next app launch.",
            )
            return
        }

        Log.d(TAG, "Boot completed - starting wake word service")
        try {
            WakeWordService.start(context)
        } catch (t: Throwable) {
            // Never let a boot receiver crash the process.
            Log.e(TAG, "Failed to start wake word service on boot", t)
        }
    }

    private fun hasUserOptedIn(context: Context): Boolean {
        // `shared_preferences` on Android persists to "FlutterSharedPreferences" and
        // prefixes every key with "flutter.".
        val prefs = context.getSharedPreferences(SHARED_PREFS_NAME, Context.MODE_PRIVATE)
        return prefs.getBoolean(WAKE_WORD_ENABLED_KEY, false)
    }

    companion object {
        const val TAG = "BootReceiver"
        const val SHARED_PREFS_NAME = "FlutterSharedPreferences"
        const val WAKE_WORD_ENABLED_KEY = "flutter.nova_wake_word_enabled"
    }
}
