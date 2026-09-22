// Plumbing check for the real-app E2E harness.
//
// If these two tests do not pass, nothing else in `integration_test/e2e/` can be
// trusted: they prove the app boots against the live API on this device, that
// the real Keystore-backed session is honoured by the router, and that the
// harness can seed and read device state.

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'e2e_support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('E2E plumbing', () {
    testWidgets('a cold start with no state reaches onboarding', (WidgetTester tester) async {
      assertApiConfigured();
      await wipeDeviceState();
      await launchRealApp(tester);

      await pumpFor(tester, const Duration(seconds: 3));
      // ignore: avoid_print
      print('[e2e] cold-start screen: ${visibleText(tester)}');

      expect(
        visibleText(tester).any(
          (String text) =>
              text.contains('Welcome') ||
              text.contains('NOVA') ||
              text.contains('Get started') ||
              text.contains('Continue'),
        ),
        isTrue,
        reason: 'expected an onboarding surface, saw: ${visibleText(tester)}',
      );
    });

    testWidgets('a seeded session reaches the signed-in home', (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      await wipeDeviceState();
      final account = await api.register(tag: 'smoke');
      await seedSession(account);

      await launchRealApp(tester);
      await pumpFor(tester, const Duration(seconds: 8));
      // ignore: avoid_print
      print('[e2e] signed-in screen: ${visibleText(tester)}');

      expect(
        visibleText(tester).any(
          (String text) =>
              text.contains('Wake word') ||
              text.contains('Good') ||
              text.contains('NOVA'),
        ),
        isTrue,
        reason: 'expected the signed-in home, saw: ${visibleText(tester)}',
      );
    });
  });
}
