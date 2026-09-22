import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';
import 'package:nova_mobile/features/auth/firebase_phone_auth.dart';

class _MockFirebaseAuth extends Mock implements FirebaseAuth {}

class _FakePhoneAuthCredential extends Fake implements PhoneAuthCredential {}

void main() {
  late _MockFirebaseAuth auth;

  setUp(() {
    auth = _MockFirebaseAuth();
    // mocktail needs a concrete instance of every non-nullable parameter type used
    // with `any(named: ...)`, including the callback typedefs.
    registerFallbackValue(_FakePhoneAuthCredential());
    registerFallbackValue(Duration.zero);
    registerFallbackValue(0);
    registerFallbackValue((PhoneAuthCredential _) {});
    registerFallbackValue((FirebaseAuthException _) {});
    registerFallbackValue((String _, int? _) {});
    registerFallbackValue((String _) {});
  });

  /// Captures the callbacks `verifyPhoneNumber` was handed so a test can fire the one
  /// it wants to exercise.
  ({
    void Function(PhoneAuthCredential) completed,
    void Function(FirebaseAuthException) failed,
    void Function(String, int?) codeSent,
    void Function(String) autoTimeout,
  }) captureCallbacks() {
    late void Function(PhoneAuthCredential) completed;
    late void Function(FirebaseAuthException) failed;
    late void Function(String, int?) codeSent;
    late void Function(String) autoTimeout;

    when(
      () => auth.verifyPhoneNumber(
        phoneNumber: any(named: 'phoneNumber'),
        timeout: any(named: 'timeout'),
        forceResendingToken: any(named: 'forceResendingToken'),
        verificationCompleted: any(named: 'verificationCompleted'),
        verificationFailed: any(named: 'verificationFailed'),
        codeSent: any(named: 'codeSent'),
        codeAutoRetrievalTimeout: any(named: 'codeAutoRetrievalTimeout'),
      ),
    ).thenAnswer((invocation) async {
      completed = invocation.namedArguments[#verificationCompleted]
          as void Function(PhoneAuthCredential);
      failed = invocation.namedArguments[#verificationFailed]
          as void Function(FirebaseAuthException);
      codeSent = invocation.namedArguments[#codeSent]
          as void Function(String, int?);
      autoTimeout = invocation.namedArguments[#codeAutoRetrievalTimeout]
          as void Function(String);
      // Never completes on its own: the callbacks are the only way out.
      await Completer<void>().future;
    });

    return (
      completed: (c) => completed(c),
      failed: (e) => failed(e),
      codeSent: (id, token) => codeSent(id, token),
      autoTimeout: (id) => autoTimeout(id),
    );
  }

  group('sendCode', () {
    test('resolves when the code has been sent', () async {
      final callbacks = captureCallbacks();
      final phoneAuth = FirebasePhoneAuth(auth: auth);

      final pending = phoneAuth.sendCode('+917868002606');
      await Future<void>.delayed(Duration.zero);
      callbacks.codeSent('verification-id', 42);

      await expectLater(pending, completes);
      expect(phoneAuth.pendingPhoneNumber, '+917868002606');
    });

    test('resolves when the platform verifies the number by itself', () async {
      final callbacks = captureCallbacks();
      final phoneAuth = FirebasePhoneAuth(auth: auth);

      final pending = phoneAuth.sendCode('+917868002606');
      await Future<void>.delayed(Duration.zero);
      callbacks.completed(_FakePhoneAuthCredential());

      await expectLater(pending, completes);
    });

    test('surfaces a refusal as a friendly failure', () async {
      final callbacks = captureCallbacks();
      final phoneAuth = FirebasePhoneAuth(auth: auth);

      final pending = phoneAuth.sendCode('+917868002606');
      await Future<void>.delayed(Duration.zero);
      callbacks.failed(
        FirebaseAuthException(code: 'too-many-requests', message: 'quota'),
      );

      await expectLater(
        pending,
        throwsA(
          isA<PhoneAuthFailure>().having(
            (e) => e.message,
            'message',
            contains('Too many attempts'),
          ),
        ),
      );
    });

    test('gives up instead of spinning when no callback ever arrives', () async {
      captureCallbacks();
      final phoneAuth = FirebasePhoneAuth(auth: auth);

      // The reproduced device failure: app verification cannot produce an
      // attestation, so neither codeSent nor verificationFailed is ever called and
      // the button span forever.
      await expectLater(
        phoneAuth.sendCode(
          '+917868002606',
          deadline: const Duration(milliseconds: 40),
        ),
        throwsA(
          isA<PhoneAuthFailure>().having(
            (e) => e.code,
            'code',
            'verification-timeout',
          ),
        ),
      );
    });
  });
}
