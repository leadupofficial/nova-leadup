import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../features/notifications/notification_controller.dart';
import '../../app/providers.dart';
import '../../features/onboarding/pending_persona_flush.dart';
import '../voice/voice_session_store.dart';

/// Clears the in-memory state that belongs to **one account**.
///
/// ## Why this exists
///
/// An adversarial audit found that signing out left the previous account's data in
/// memory, because every one of these providers is a plain (non-`autoDispose`)
/// `NotifierProvider` and nothing reset them:
///
///   * `activeConversationProvider` and `transcriptProvider` hold the conversation id and
///     the rendered transcript. `ConversePage` returns early when an id is already set, so
///     the **next person to sign in on the same process saw the previous user's transcript
///     on screen** and their turns were posted into the previous user's conversation.
///   * the notification assistant's `inbox` keeps the titles and bodies of notifications
///     the previous account's assistant read aloud, and `sessionSpeechConsent` — which
///     §9.3 says is a *per-session* confirmation, so it must not survive into another
///     session either.
///   * a persona chosen during onboarding but not yet flushed belongs to whoever was
///     mid-onboarding. Left in place, account A's companion could be written to account B
///     after a sign-out and a different sign-in.
///
/// A process restart cleared all of it, which is why this went unnoticed: the leak needs
/// two accounts and one running process.
///
/// Called from **every** path that drops a session — `logout` and
/// `handleRefreshFailure`. If a third path is ever added, it needs this too; the failure
/// is silent and only shows up as somebody else's data on screen.
/// Asynchronous because one piece of the state is on disk rather than in memory: the
/// pending companion is stored by `OnboardingService` under a key that carries **no
/// owner**. Invalidating the notifier above stops the flush from running, but the stored
/// JSON survives, so the next account to sign in would flush the previous user's name,
/// personality and speech style to itself on the following launch. Clearing the stored
/// copy is what actually closes that.
Future<void> clearAccountScopedState(Ref ref) async {
  ref.invalidate(activeConversationProvider);
  ref.invalidate(transcriptProvider);
  ref.invalidate(notificationAssistantProvider);
  ref.invalidate(pendingPersonaFlushProvider);
  await ref.read(onboardingServiceProvider).clearPendingPersona();
}
