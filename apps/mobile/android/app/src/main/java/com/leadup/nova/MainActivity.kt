package com.leadup.nova

import android.content.Intent
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * NOVA's single Android Activity, hosted by the Flutter v2 embedding.
 *
 * Extends [FlutterFragmentActivity] rather than plain `FlutterActivity` so the
 * foreground Activity is an `androidx.fragment.app.FragmentActivity`. That is what
 * `ACTION_OPEN_DOCUMENT_TREE` (the call-recording folder picker) needs in order to
 * deliver its result through `onActivityResult` on every supported API level.
 *
 * This comment previously said `local_auth` required it. `local_auth` is **not** a
 * dependency of this app — `pubspec.yaml` has no biometric package and the manifest
 * declares no `USE_BIOMETRIC` — so that reason was wrong, even though
 * `FlutterFragmentActivity` remains the right base class for the picker.
 *
 * This class previously extended `ReactActivity` as a leftover from the earlier
 * Expo/React Native implementation. That leftover made Flutter's tooling classify the
 * project as using the deleted Android v1 embedding and refuse to build at all.
 */
class MainActivity : FlutterFragmentActivity() {

    /**
     * The call-recording folder channel, kept only so [onActivityResult] can be
     * forwarded to it. `ACTION_OPEN_DOCUMENT_TREE` (requirement 6c) is a system
     * picker that only an Activity can launch and receive; every other NOVA
     * channel is activity-free.
     */
    private var callRecordingFolder: NovaCallRecordingFolder? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        // Exposes the native wake-word service to Dart
        // (lib/core/voice/wake_word_service.dart). Registered here so the bridge is
        // available for the whole lifetime of the Flutter engine.
        WakeWordService.registerChannels(
            flutterEngine.dartExecutor.binaryMessenger,
            applicationContext,
        )

        // Exposes the notification listener to Dart
        // (lib/features/notifications/notification_platform.dart): its status, the
        // Android Notification Access screen, and the stream of notifications that
        // survived the on-device filter.
        NovaNotificationListenerService.registerChannels(
            flutterEngine.dartExecutor.binaryMessenger,
            applicationContext,
        )

        // Exposes device & system control to Dart
        // (lib/features/device_control/device_control_platform.dart): opening
        // apps and deep links, the dialer, the Wi-Fi/Bluetooth settings panels,
        // brightness and Do Not Disturb (each behind its special access), and
        // media transport keys.
        NovaDeviceControl.registerChannels(
            flutterEngine.dartExecutor.binaryMessenger,
            applicationContext,
        )

        // Exposes the user's own call-recording folder to Dart
        // (lib/features/call_recording/call_recording_platform.dart): the system
        // folder picker plus `takePersistableUriPermission`, the audio files
        // inside the chosen folder, and the bytes of one file the user selected.
        // NOVA does not record, listen to, or screen a call — see
        // CallRecordingFolderPolicy for why it cannot and does not.
        callRecordingFolder = NovaCallRecordingFolder.registerChannels(
            flutterEngine.dartExecutor.binaryMessenger,
            this,
            applicationContext,
        )

        // Exposes this app's own notification settings screen to Dart
        // (lib/features/reminders/reminder_notifications.dart). A denied
        // POST_NOTIFICATIONS makes Android discard every reminder silently, so the
        // warning the reconciler now raises has to lead somewhere the user can act.
        NovaNotificationSettings.registerChannels(
            flutterEngine.dartExecutor.binaryMessenger,
            applicationContext,
        )
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        // The folder channel answers the pending Dart future itself. A result it
        // does not recognise is left to the superclass, so no plugin's handling
        // is swallowed by adding this.
        val consumed =
            callRecordingFolder?.onActivityResult(requestCode, resultCode, data) ?: false
        if (!consumed) {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    override fun onResume() {
        super.onResume()
        // While the app is on screen, a wake-word detection is handled inside the app.
        // While it is not, `WakeWordService` posts a notification instead, because Dart
        // deliberately does not open a conversation in the background. This is the only
        // signal the service has for "on screen", so it is kept current on every resume.
        WakeWordService.setAppInForeground(true)
    }

    override fun onPause() {
        // Set before `super` so the service never sees a resumed Activity once the
        // framework has started tearing the foreground state down.
        WakeWordService.setAppInForeground(false)
        super.onPause()
    }
}
