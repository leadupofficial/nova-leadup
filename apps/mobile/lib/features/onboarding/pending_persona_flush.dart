import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../core/api/models.dart';
import '../../core/api/nova_api.dart';
import '../auth/auth_controller.dart';

/// Pushes the companion the user configured during onboarding, once they have signed in.
///
/// Onboarding runs **before** sign-in, and `PUT /api/v1/settings/persona` is
/// authenticated, so on a fresh install the save in `CompanionPage` always failed with
/// "Missing or invalid authorization header". That screen handled it by keeping the
/// choice under `savePendingPersona` and telling the user "the choice is stored and will
/// be pushed after sign-in" — and then **nothing ever pushed it**, because the very next
/// line called `clearPendingPersona()` unconditionally. A user who named their companion
/// and chose a personality and speech style got the defaults back on every later launch,
/// and the copy promising otherwise was simply untrue.
///
/// This is the missing half. It follows the shape of `ReminderSyncController`: the
/// notifier is built once for the app's lifetime, watches the auth state, and acts on the
/// first authenticated frame. It is safe to call repeatedly and clears the stored copy
/// only after the server has accepted it.
class PendingPersonaFlush extends Notifier<int> {
  bool _running = false;

  /// How many times a deferred companion has been pushed. Exposed so a test can wait
  /// for the flush without reaching into private state.
  @override
  int build() {
    final authenticated = ref.watch(
      authStateProvider.select((state) => state.isAuthenticated),
    );

    if (authenticated) {
      // Deferred: the flush writes state, which is illegal while `build` is running.
      unawaited(Future<void>.microtask(flush));
    }

    return 0;
  }

  /// Pushes a pending companion if there is one. Returns whether one was sent.
  Future<bool> flush() async {
    if (_running) return false;
    final onboarding = ref.read(onboardingServiceProvider);
    final pending = onboarding.getPendingPersona();
    if (pending == null) return false;

    // Signing out and back in as a *different* user must not write the first user's
    // companion to the second account. The flush only runs while authenticated, so the
    // bearer token belongs to whoever is signed in now; if the pending value was left by
    // a previous session it is still that session's choice, and there is no owner on the
    // record to compare against. Clearing it after a successful push is what bounds the
    // exposure: it can be written at most once, to whoever signs in first.
    if (!ref.read(authStateProvider).isAuthenticated) return false;

    _running = true;
    try {
      final persona = NovaPersona.fromJson(pending);
      // Straight to the API rather than through `NovaMutations.savePersona`.
      //
      // This runs on the frame the auth state flips to authenticated, which is exactly
      // when `novaApiProvider` — and with it anything holding a `Ref` derived from it —
      // is being rebuilt. `NovaMutations` captures its provider's `Ref` to invalidate
      // caches after each call, so reaching it here threw
      // *"Cannot use the Ref of Provider<NovaMutations> after it has been disposed"* and
      // the companion was kept for a later attempt, every time.
      //
      // The flush has no caches to invalidate: it writes once, before any screen has
      // read the persona. A test caught this only because it drives the real sign-in
      // transition rather than calling `flush()` directly.
      await ref.read(novaApiProvider).updatePersona(persona);

      // Only now. Clearing before the push is what lost the companion in the first
      // place, and clearing after a *failure* would lose it just as completely.
      await onboarding.clearPendingPersona();
      if (ref.mounted) state = state + 1;
      return true;
    } catch (error) {
      // Kept deliberately: the next authenticated launch tries again. This is the
      // expected path on a device that is offline at sign-in time.
      debugPrint('[PendingPersona] keeping the companion for a later attempt: $error');
      return false;
    } finally {
      _running = false;
    }
  }
}

/// Built once from `NovaApp` so it lives for the whole session, exactly like
/// `reminderSyncProvider`.
final pendingPersonaFlushProvider =
    NotifierProvider<PendingPersonaFlush, int>(PendingPersonaFlush.new);
