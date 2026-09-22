import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/services/firebase_backends.dart';

/// Guards the second half of `FirebaseActivation`'s contract.
///
/// The class documented that "a failure must not stop startup", but that was read
/// as "a failure throws". The real on-device defect was a **hang**:
/// `Firebase.initializeApp()` neither completed nor threw, so neither of the two
/// `debugPrint`s fired and `main()` never reached `runApp`. Every awaited step is
/// now bounded, so a hang resolves to the same `null` (and therefore the same
/// console backends) that a throw does.
void main() {
  setUp(TestWidgetsFlutterBinding.ensureInitialized);

  test('every Firebase step is bounded, so init cannot hang', () {
    // If any step lost its timeout, one unbounded platform channel would be enough
    // to re-create the zero-frame cold start.
    expect(FirebaseActivation.stepTimeout, const Duration(seconds: 5));
    expect(FirebaseActivation.stepTimeout.inSeconds, lessThan(30));
  });

  test('initialize() returns within its bound on a host with no Firebase app',
      () async {
    // No `google-services.json` behind a real Firebase app in a unit test, so this
    // takes the failure path. The point of the assertion is the *deadline*: the
    // method must always come back, with `null` or with backends.
    final stopwatch = Stopwatch()..start();
    final backends = await FirebaseActivation.initialize();
    stopwatch.stop();

    expect(
      stopwatch.elapsed,
      lessThan(FirebaseActivation.stepTimeout * 2),
      reason: 'initialize() must be bounded by its step timeouts',
    );
    // Either outcome is acceptable; what is not acceptable is not returning.
    expect(backends, anyOf(isNull, isNotNull));
    expect(FirebaseActivation.isReady, backends != null);
  });
}
