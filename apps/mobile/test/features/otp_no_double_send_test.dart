import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/app/app.dart';
import 'package:nova_mobile/app/router.dart';
import 'package:nova_mobile/features/onboarding/otp_page.dart';

import '../helpers/test_harness.dart';

/// The login screen sends the code and only then routes to the OTP step, so the
/// step must not send another one on first build. It did: the route builder never
/// passed `requestOnStart`, which defaults to true, so every phone sign-in fired a
/// second SMS for the same number.
void main() {
  testWidgets('routing to the OTP step does not send a second code', (tester) async {
    useTallSurface(tester);
    // Onboarding complete and no session: the auth gate lets the OTP route through
    // (it is an auth route) without bouncing to `/` or to an onboarding step.
    final deps = await createTestDependencies(
      preferences: <String, Object>{'nova_onboarding_status': 'complete'},
    );
    addTearDown(deps.dispose);

    var sends = 0;
    await tester.pumpWidget(
      testScope(deps, const NovaApp(), networkService: emptyApiNetworkService()),
    );
    await tester.pumpAndSettle();

    final container = ProviderScope.containerOf(
      tester.element(find.byType(NovaApp)),
    );
    container.read(routerProvider).push(
      '/onboarding/otp',
      extra: OtpPageArgs(
        phone: '+917868002606',
        requestCode: (String _) async => sends++,
        verifyCode: (String _, String _) async => <String, dynamic>{
          'verified': true,
        },
      ),
    );
    await tester.pumpAndSettle();

    expect(find.textContaining('2606'), findsOneWidget);
    expect(
      sends,
      0,
      reason: 'the caller already sent the code before routing here',
    );
  });
}
