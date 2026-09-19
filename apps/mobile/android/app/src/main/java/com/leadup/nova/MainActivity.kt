package com.leadup.nova

import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine

/**
 * NOVA's single Android Activity, hosted by the Flutter v2 embedding.
 *
 * Extends [FlutterFragmentActivity] rather than plain `FlutterActivity` because the
 * `local_auth` plugin requires the foreground Activity to be an
 * `androidx.fragment.app.FragmentActivity` in order to show the biometric prompt.
 * With plain `FlutterActivity`, `authenticate()` fails at runtime.
 *
 * This class previously extended `ReactActivity` as a leftover from the earlier
 * Expo/React Native implementation. That leftover made Flutter's tooling classify the
 * project as using the deleted Android v1 embedding and refuse to build at all.
 */
class MainActivity : FlutterFragmentActivity() {

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
    }
}
