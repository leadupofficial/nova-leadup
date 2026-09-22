import 'package:flutter/foundation.dart';
import '../../core/state/account_scoped_state.dart';
import '../reminders/notification_delivery_cache.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../services/analytics_service.dart';
import 'auth_api.dart';
import 'auth_repository.dart';

enum AuthStatus {
  unauthenticated,
  authenticated,
}

@immutable
class AuthState {
  const AuthState({
    this.status = AuthStatus.unauthenticated,
    this.user,
    this.isSubmitting = false,
    this.error,
  });

  final AuthStatus status;
  final AuthUser? user;
  final bool isSubmitting;
  final String? error;

  bool get isAuthenticated => status == AuthStatus.authenticated;

  @override
  bool operator ==(Object other) =>
      other is AuthState &&
      other.status == status &&
      other.user?.id == user?.id &&
      other.isSubmitting == isSubmitting &&
      other.error == error;

  @override
  int get hashCode => Object.hash(status, user?.id, isSubmitting, error);
}

/// Owns the authentication state that the router and the UI react to.
class AuthController extends Notifier<AuthState> {
  @override
  AuthState build() {
    // Bootstrap already called AuthRepository.restore(), so this read is synchronous
    // and the first frame can route without a loading gate.
    final repository = ref.read(authRepositoryProvider);
    return AuthState(
      status: repository.isLoggedIn ? AuthStatus.authenticated : AuthStatus.unauthenticated,
      user: repository.currentUser,
    );
  }

  Future<bool> login({required String email, required String password}) {
    return _submit(
      () => ref.read(authApiProvider).login(email: email, password: password),
      analyticsEvent: AnalyticsService.eventLogin,
      failureReason: 'login',
    );
  }

  /// Completes a phone sign-in that Firebase has already verified.
  ///
  /// The ID token proves the phone number to Google; the server verifies it and returns
  /// a NOVA session, which is then persisted exactly as an email sign-in would be — the
  /// client has one session model, not two.
  Future<bool> loginWithFirebaseIdToken(String idToken) {
    return _submit(
      () => ref.read(authApiProvider).exchangeFirebaseToken(idToken),
      analyticsEvent: AnalyticsService.eventLogin,
      failureReason: 'firebase-phone-login',
    );
  }

  Future<bool> register({
    required String email,
    required String password,
    String? name,
  }) {
    return _submit(
      () => ref.read(authApiProvider).register(email: email, password: password, name: name),
      analyticsEvent: AnalyticsService.eventSignUp,
      failureReason: 'register',
    );
  }

  Future<void> logout() async {
    final token = ref.read(authRepositoryProvider).currentToken;
    if (token != null) {
      await ref.read(authApiProvider).logout(
            token.accessToken,
            // Identifies this device so the server revokes only this session.
            refreshToken: token.refreshToken,
          );
    }
    await ref.read(authRepositoryProvider).clearSession();
    // Everything the previous account left in memory — the open conversation and its
    // transcript, the notification assistant's inbox, a persona mid-onboarding. Without
    // this the next person to sign in on this process sees the previous user's transcript
    // and posts into their conversation.
    await clearAccountScopedState(ref);
    // The notification-delivery cache is device-scoped, not account-scoped: leaving it
    // in place means a second account on this device inherits the first account's
    // off-state and has its reminders silently suppressed.
    await clearNotificationDeliveryCache(ref.read(sharedPreferencesProvider));
    await ref.read(crashReportingServiceProvider).setUserId(null);
    await ref.read(analyticsServiceProvider).setUserId(null);
    await ref.read(analyticsServiceProvider).logEvent(AnalyticsService.eventLogout);
    state = const AuthState();
  }

  /// Called by [AuthInterceptor] when refreshing the access token failed.
  ///
  /// The stored session is no longer usable, so the app drops to signed-out; the
  /// router's auth gate then returns the user to the login screen.
  Future<void> handleRefreshFailure() async {
    // Several in-flight requests can report the same expiry; only react once.
    if (state.status == AuthStatus.unauthenticated && state.error != null) return;

    await ref.read(authRepositoryProvider).clearSession();
    await clearAccountScopedState(ref);
    await clearNotificationDeliveryCache(ref.read(sharedPreferencesProvider));
    await ref.read(crashReportingServiceProvider).setUserId(null);
    await ref.read(analyticsServiceProvider).setUserId(null);
    state = const AuthState(
      error: 'Your session expired. Please sign in again.',
    );
  }

  /// Clears a displayed error, e.g. when the user edits the form again.
  void clearError() {
    if (state.error == null) return;
    state = AuthState(status: state.status, user: state.user);
  }

  Future<bool> _submit(
    Future<AuthSession> Function() call, {
    required String analyticsEvent,
    required String failureReason,
  }) async {
    if (state.isSubmitting) return false;

    state = AuthState(status: state.status, user: state.user, isSubmitting: true);

    try {
      final session = await call();
      await ref
          .read(authRepositoryProvider)
          .saveSession(session.token, user: session.user);

      await ref.read(crashReportingServiceProvider).setUserId(session.user?.id);
      await ref.read(analyticsServiceProvider).setUserId(session.user?.id);
      await ref.read(analyticsServiceProvider).logEvent(analyticsEvent);

      state = AuthState(status: AuthStatus.authenticated, user: session.user);
      return true;
    } on AuthException catch (error) {
      state = AuthState(
        status: AuthStatus.unauthenticated,
        isSubmitting: false,
        error: error.message,
      );
      return false;
    } catch (error, stackTrace) {
      await ref.read(crashReportingServiceProvider).recordError(
            error,
            stackTrace,
            reason: failureReason,
          );
      state = const AuthState(
        isSubmitting: false,
        error: 'Something went wrong. Please try again.',
      );
      return false;
    }
  }
}

final authStateProvider = NotifierProvider<AuthController, AuthState>(
  AuthController.new,
);
