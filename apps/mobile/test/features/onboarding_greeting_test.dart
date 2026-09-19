import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/onboarding/onboarding_greeting.dart';
import 'package:nova_mobile/features/onboarding/onboarding_service.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/voice/voice_realtime_test_support.dart' show FakeDeviceTts;

/// The completion greeting: it must be spoken exactly once, in the language the
/// user chose, and must say so instead of staying silent when the device has no
/// voice for that language.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<
    ({
      OnboardingGreeting greeting,
      FakeDeviceTts tts,
      SharedPreferences preferences,
      OnboardingService onboarding,
    })
  >
  harness({
    String? policy,
    Set<String> unsupported = const <String>{},
  }) async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final preferences = await SharedPreferences.getInstance();
    final onboarding = OnboardingService(preferences);
    if (policy != null) await onboarding.saveLanguagePolicy(policy);
    final tts = FakeDeviceTts(unsupported: unsupported);
    return (
      greeting: OnboardingGreeting(
        preferences: preferences,
        tts: tts,
        onboarding: onboarding,
      ),
      tts: tts,
      preferences: preferences,
      onboarding: onboarding,
    );
  }

  group('one-shot guard', () {
    test('speaks once and never repeats itself', () async {
      final h = await harness(policy: 'en');

      final first = await h.greeting.speakOnce(deviceLanguageCode: 'en');
      expect(first.outcome, GreetingOutcome.spoken);
      expect(h.tts.spoken, hasLength(1));

      final second = await h.greeting.speakOnce(deviceLanguageCode: 'en');
      expect(second.outcome, GreetingOutcome.alreadySpoken);
      expect(
        h.tts.spoken,
        hasLength(1),
        reason: 'the completion callback can fire again; the greeting must not',
      );
      expect(h.preferences.getBool(OnboardingGreeting.spokenKey), isTrue);
    });

    test('the flag is persisted, so a new service instance stays silent', () async {
      final h = await harness(policy: 'en');
      await h.greeting.speakOnce(deviceLanguageCode: 'en');

      // A new instance over the same store is what a resume looks like.
      final rebuilt = OnboardingGreeting(
        preferences: h.preferences,
        tts: h.tts,
        onboarding: h.onboarding,
      );
      final result = await rebuilt.speakOnce(deviceLanguageCode: 'en');

      expect(result.outcome, GreetingOutcome.alreadySpoken);
      expect(h.tts.spoken, hasLength(1));
    });

    test('two concurrent calls only produce one utterance', () async {
      final h = await harness(policy: 'en');

      final results = await Future.wait(<Future<GreetingResult>>[
        h.greeting.speakOnce(deviceLanguageCode: 'en'),
        h.greeting.speakOnce(deviceLanguageCode: 'en'),
      ]);

      expect(h.tts.spoken, hasLength(1));
      expect(
        results.where((r) => r.outcome == GreetingOutcome.spoken),
        hasLength(1),
      );
    });
  });

  group('language policy', () {
    test('en picks the English greeting and the English voice', () async {
      final h = await harness(policy: 'en');

      final result = await h.greeting.speakOnce(deviceLanguageCode: 'ta');

      expect(result.languageTag, 'en-IN');
      expect(h.tts.spoken.single, kGreetingTextByPolicy['en']);
      expect(h.tts.spokenLanguages.single, 'en-IN');
    });

    test('ta speaks Tamil script with the Tamil voice', () async {
      final h = await harness(policy: 'ta');

      final result = await h.greeting.speakOnce(deviceLanguageCode: 'en');

      expect(result.languageTag, 'ta-IN');
      expect(h.tts.spoken.single, kGreetingTextByPolicy['ta']);
      expect(h.tts.spoken.single, contains('வணக்கம்'));
    });

    test('tanglish speaks romanised Tamil on the device default voice', () async {
      final h = await harness(policy: 'tanglish');

      final result = await h.greeting.speakOnce(deviceLanguageCode: 'ta');

      expect(h.tts.spoken.single, kGreetingTextByPolicy['tanglish']);
      // Romanised Tamil carries no script signal, so the shared helper answers
      // "device default" rather than guessing a Tamil voice that would read
      // Latin letters.
      expect(result.languageTag, isNull);
      expect(h.tts.spokenLanguages.single, isNull);
    });

    test('auto follows the device language', () async {
      final tamilDevice = await harness();
      final tamil = await tamilDevice.greeting.speakOnce(deviceLanguageCode: 'ta');
      expect(tamil.languageTag, 'ta-IN');
      expect(tamilDevice.tts.spoken.single, kGreetingTextByPolicy['ta']);

      final englishDevice = await harness();
      final english = await englishDevice.greeting.speakOnce(
        deviceLanguageCode: 'en',
      );
      expect(englishDevice.tts.spoken.single, kGreetingTextByPolicy['en']);
      // English text has no script signal, so the device default voice reads it.
      expect(english.languageTag, isNull);
    });

    test('a policy with no greeting falls back to English, not silence', () async {
      final h = await harness(policy: 'hi');

      final result = await h.greeting.speakOnce(deviceLanguageCode: 'en');

      expect(result.outcome, GreetingOutcome.spoken);
      expect(h.tts.spoken.single, kGreetingTextByPolicy['en']);
    });
  });

  group('missing voice', () {
    test('reports the missing voice instead of silently doing nothing', () async {
      final h = await harness(policy: 'ta', unsupported: <String>{'ta-IN'});

      final result = await h.greeting.speakOnce(deviceLanguageCode: 'en');

      expect(result.outcome, GreetingOutcome.noDeviceVoice);
      expect(result.notice, isNotNull);
      expect(result.notice, contains('ta-IN'));
      expect(h.tts.spoken, isEmpty);
    });

    test('is retried once the voice exists, because nothing was said', () async {
      final h = await harness(policy: 'ta', unsupported: <String>{'ta-IN'});
      await h.greeting.speakOnce(deviceLanguageCode: 'en');
      expect(h.preferences.getBool(OnboardingGreeting.spokenKey), isNot(true));

      h.tts.unsupported.clear();
      final retry = await h.greeting.speakOnce(deviceLanguageCode: 'en');

      expect(retry.outcome, GreetingOutcome.spoken);
      expect(h.tts.spoken.single, kGreetingTextByPolicy['ta']);
    });
  });
}
