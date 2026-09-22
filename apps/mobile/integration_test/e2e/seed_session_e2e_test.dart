// Seeds a signed-in session on the device so the reminder-delivery experiment can
// be driven entirely from the shell, with no test harness in the loop.
//
// Why this file exists: `flutter test integration_test` stops the app when the
// last test returns, and that teardown cancels the alarms the test just armed —
// so a reminder can never be observed firing after the harness exits. The only
// honest way to test "the app is completely closed" is to get the app into a
// signed-in state with `--no-uninstall`, then drive it with `adb` alone:
//
//   1. flutter test integration_test/e2e/seed_session_e2e_test.dart -d <dev> --no-uninstall
//      -> prints `[e2e][seed] TOKEN <access_token>`; capture it
//   2. ** REBUILD AND REINSTALL THE REAL APP. ** Step 1 ran `flutter test`, which
//      builds the app with THIS FILE as its Dart entrypoint and writes that build
//      to the same `build/app/outputs/flutter-apk/app-*.apk` paths `flutter build`
//      uses — including the `--target-platform android-arm64` split. `adb install`
//      of those paths therefore reinstalls the harness, and a cold start then runs
//      `IntegrationTestWidgetsFlutterBinding` waiting for a `flutter test` driver
//      that is not there: no `runApp`, so no Flutter frame is ever produced and
//      Android's starting window stays up for ever (splash icon on navy, 0 frames,
//      `ext.flutter.debugDumpApp` absent from the VM service). Rebuild from the app
//      target first, and confirm the freshly built APK is not the harness:
//        flutter build apk --debug --target-platform android-arm64 \
//          --dart-define=API_URL=http://localhost:3001
//        adb install -r -t build/app/outputs/flutter-apk/app-arm64-v8a-debug.apk
//   3. curl -H "Authorization: Bearer $TOKEN" ... POST /api/v1/reminders  (a few min out)
//   4. adb shell am start -n com.leadup.nova/.MainActivity    # the real app syncs, arming the alarm
//   5. adb shell input keyevent KEYCODE_HOME                  # background it
//   6. adb shell am kill com.leadup.nova                      # process gone, app NOT stopped
//   7. wait past the trigger time, then:
//      adb shell dumpsys notification --noredact | grep nova_reminders
//
// `am kill`, not `am force-stop`: force-stop puts the package in the stopped
// state, which cancels its alarms and blocks its broadcasts — that would test
// Android's stopped-app rules rather than NOVA's reminders.

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'e2e_support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('seed a signed-in session for shell-driven testing', (WidgetTester tester) async {
    assertApiConfigured();
    final api = E2eApi();
    addTearDown(api.close);

    await wipeDeviceState();
    final account = await api.register(tag: 'shellseed');
    await seedSession(account);

    // The token is the handoff: the shell uses it to create the reminder as this
    // same user, so the app fetches it on its next sync.
    // ignore: avoid_print
    print('[e2e][seed] TOKEN ${account.accessToken}');
    // ignore: avoid_print
    print('[e2e][seed] USER ${account.userId} EMAIL ${account.email}');
    // ignore: avoid_print
    print('[e2e][seed] session written to the real Keystore-backed store; '
        'onboarding marked complete');

    // Say it out loud, because the failure it prevents is silent and looks exactly
    // like a broken app: this run has just replaced the installed app with one whose
    // Dart entrypoint is this test file. Cold-starting that build with `am start`
    // renders no frame at all — the native splash stays up for ever.
    // ignore: avoid_print
    print('[e2e][seed] WARNING: the installed app is now the TEST build. Rebuild '
        'from the app target and reinstall before driving it with adb, or '
        '`am start` will hang on the splash screen:\n'
        '  flutter build apk --debug --target-platform android-arm64 '
        '--dart-define=API_URL=http://localhost:3001\n'
        '  adb install -r -t '
        'build/app/outputs/flutter-apk/app-arm64-v8a-debug.apk');
  });
}
