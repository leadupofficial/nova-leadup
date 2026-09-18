import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum VoiceState {
  inactive,
  ready,
  listening,
  processing,
  speaking,
  error,
}

class VoiceStateNotifier extends AsyncNotifier<VoiceState> {
  @override
  FutureOr<VoiceState> build() async {
    return VoiceState.ready;
  }

  Future<void> setState(VoiceState newState) async {
    state = AsyncData(newState);
  }
}

final voiceProvider =
    AsyncNotifierProvider<VoiceStateNotifier, VoiceState>(() {
  return VoiceStateNotifier();
});
