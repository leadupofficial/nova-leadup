import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../api/models.dart';

/// The active conversation id for the Converse session; `null` means "not yet
/// resolved" — the screen loads the newest conversation, or creates one.
class ActiveConversation extends Notifier<String?> {
  @override
  String? build() => null;

  void set(String id) => state = id;
}

final activeConversationProvider =
    NotifierProvider<ActiveConversation, String?>(ActiveConversation.new);

/// Local transcript for the active conversation.
///
/// Held separately from `messagesProvider` so an optimistic user bubble, a
/// realtime voice turn, and the assistant's reply can be appended without a
/// full refetch flicker.
class Transcript extends Notifier<List<NovaMessage>> {
  @override
  List<NovaMessage> build() => const [];

  void set(List<NovaMessage> messages) => state = messages;
}

final transcriptProvider = NotifierProvider<Transcript, List<NovaMessage>>(
  Transcript.new,
);
