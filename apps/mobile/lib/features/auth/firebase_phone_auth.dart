import 'dart:async';

import 'package:firebase_auth/firebase_auth.dart';

/// A phone sign-in that could not complete, with a message fit to show a user.
class PhoneAuthFailure implements Exception {
  const PhoneAuthFailure(this.message, {this.code});

  final String message;
  final String? code;

  @override
  String toString() => message;
}

/// Firebase Phone Authentication, wrapped so the UI never touches the SDK directly.
///
/// ## Why the error messages are written out by hand
///
/// Firebase's own text for these failures is either empty ("An internal error has
/// occurred") or aimed at a developer. The codes that matter in production are the two
/// configuration ones — `missing-client-identifier` and `app-not-authorized` — which in
/// practice mean the **signing certificate is not registered on the Firebase project**,
/// not that the user did anything wrong. Reporting those as "invalid number" sends the
/// user and the operator both in the wrong direction, so they are named for what they
/// are.
///
/// ## The auto-retrieval path is not optional
///
/// On Android the platform may verify the SMS itself and hand back a credential without
/// the user typing anything. That arrives through `verificationCompleted`, which can fire
/// *before* `codeSent` — so a caller that only listens for the code would hang on a device
/// that had already succeeded. [sendCode] therefore completes on whichever arrives first
/// and [signIn] prefers the auto credential when there is one.
class FirebasePhoneAuth {
  FirebasePhoneAuth({FirebaseAuth? auth}) : _injected = auth;

  final FirebaseAuth? _injected;

  /// Resolved lazily on purpose: constructing this class must never touch Firebase.
  /// The sign-in screen is built before a Firebase app is guaranteed to exist (and in
  /// widget tests none does), so resolving it in the constructor threw `[core/no-app]`
  /// while `build` was running.
  FirebaseAuth get _auth => _injected ?? FirebaseAuth.instance;

  String? _verificationId;
  int? _resendToken;
  PhoneAuthCredential? _autoCredential;

  /// The number Firebase is currently verifying, as it was submitted.
  String? get pendingPhoneNumber => _pendingPhone;
  String? _pendingPhone;

  /// Sends a verification code to [phoneNumber] (E.164, with the leading `+`).
  ///
  /// Completes when the code has been sent **or** the platform has already verified the
  /// number by itself. Throws [PhoneAuthFailure] if the request is refused.
  ///
  /// [deadline] bounds the *request*, which [timeout] does not: Firebase's own
  /// `timeout` only governs how long it keeps trying to read the SMS automatically.
  /// If the app-verification step (Play Integrity / reCAPTCHA) cannot produce an
  /// attestation, none of the callbacks ever fire and the caller would otherwise
  /// spin forever — reproduced on a OnePlus 9R with the reCAPTCHA Enterprise API
  /// disabled in the project. A deadline turns that into an explained, retryable
  /// failure.
  Future<void> sendCode(
    String phoneNumber, {
    Duration timeout = const Duration(seconds: 60),
    Duration deadline = const Duration(seconds: 45),
  }) {
    final completer = Completer<void>();
    _autoCredential = null;
    _pendingPhone = phoneNumber;

    Timer? timer;

    void finish([Object? error]) {
      if (completer.isCompleted) return;
      timer?.cancel();
      if (error != null) {
        completer.completeError(error);
      } else {
        completer.complete();
      }
    }

    final FirebaseAuth auth;
    try {
      auth = _auth;
    } catch (error) {
      // Firebase is not configured in this build: report it as a normal failure so
      // the screen can explain itself instead of crashing during a build.
      return Future<Never>.error(
        PhoneAuthFailure('Phone sign-in is unavailable in this build. $error'),
      );
    }

    timer = Timer(deadline, () {
      finish(
        const PhoneAuthFailure(
          'We could not reach the verification service. Check your connection and '
          'try again.',
          code: 'verification-timeout',
        ),
      );
    });

    auth
        .verifyPhoneNumber(
          phoneNumber: phoneNumber,
          timeout: timeout,
          forceResendingToken: _resendToken,
          verificationCompleted: (PhoneAuthCredential credential) {
            // The device solved it without the user. Keep the credential and let the
            // caller proceed straight through sign-in.
            _autoCredential = credential;
            finish();
          },
          verificationFailed: (FirebaseAuthException error) {
            finish(PhoneAuthFailure(_describe(error), code: error.code));
          },
          codeSent: (String verificationId, int? resendToken) {
            _verificationId = verificationId;
            _resendToken = resendToken;
            finish();
          },
          codeAutoRetrievalTimeout: (String verificationId) {
            // Not a failure: the user simply has to type the code now.
            _verificationId = verificationId;
          },
        )
        .catchError((Object error) {
          finish(
            error is FirebaseAuthException
                ? PhoneAuthFailure(_describe(error), code: error.code)
                : PhoneAuthFailure('Could not start phone verification. $error'),
          );
        });

    return completer.future;
  }

  /// Confirms [code] and returns a **Firebase ID token**.
  ///
  /// The token is not a NOVA session; the caller posts it to
  /// `/api/v1/auth/firebase/exchange` to get one.
  Future<String> signIn(String code) async {
    final PhoneAuthCredential credential;
    final automatic = _autoCredential;
    if (automatic != null) {
      credential = automatic;
    } else {
      final verificationId = _verificationId;
      if (verificationId == null) {
        throw const PhoneAuthFailure(
          'That code has expired. Please request a new one.',
          code: 'no-verification-id',
        );
      }
      credential = PhoneAuthProvider.credential(
        verificationId: verificationId,
        smsCode: code,
      );
    }

    final UserCredential result;
    try {
      result = await _auth.signInWithCredential(credential);
    } on FirebaseAuthException catch (error) {
      throw PhoneAuthFailure(_describe(error), code: error.code);
    }

    final user = result.user;
    if (user == null) {
      throw const PhoneAuthFailure('Sign-in did not complete. Please try again.');
    }

    // Force a refresh so the token we trade carries the phone claim from this sign-in
    // rather than a cached one from a previous session on the device.
    final token = await user.getIdToken(true);
    if (token == null || token.isEmpty) {
      throw const PhoneAuthFailure('Sign-in did not produce a valid token.');
    }
    return token;
  }

  Future<void> signOut() async {
    _verificationId = null;
    _resendToken = null;
    _autoCredential = null;
    _pendingPhone = null;
    await _auth.signOut();
  }

  static String _describe(FirebaseAuthException error) {
    switch (error.code) {
      case 'invalid-phone-number':
        return 'That phone number is not valid. Check the country code and try again.';
      case 'too-many-requests':
        return 'Too many attempts on this number. Please wait a little while and try again.';
      case 'quota-exceeded':
        return 'The SMS quota for this project has been used up. Please try again later.';
      case 'invalid-verification-code':
        return 'That code is not correct. Please check it and try again.';
      case 'session-expired':
        return 'That code has expired. Please request a new one.';
      case 'missing-client-identifier':
      case 'app-not-authorized':
        // The one that looks like a user error and is not: Android could not prove this
        // app's identity, which means the signing certificate is missing from the
        // Firebase project or the package name does not match.
        return 'This build is not authorised for phone sign-in yet. '
            'The app signing certificate must be registered with the sign-in provider.';
      case 'operation-not-allowed':
        return 'Phone sign-in is not enabled for this project yet.';
      case 'network-request-failed':
        return 'No connection. Check your network and try again.';
      default:
        return error.message?.trim().isNotEmpty == true
            ? error.message!.trim()
            : 'Phone sign-in failed. Please try again.';
    }
  }
}
