import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:nova_mobile/core/avatar/avatar_provider.dart';
import 'package:nova_mobile/core/voice/voice_provider.dart';

void main() {
 test('Avatar and Voice providers initialize in v3 AsyncNotifier pattern', () {
 final container = ProviderContainer();
 addTearDown(container.dispose);
 expect(container.read(avatarStateProvider), isA<AsyncValue<AvatarState>>());
 expect(container.read(voiceProvider), isA<AsyncValue<VoiceState>>());
 });
}
