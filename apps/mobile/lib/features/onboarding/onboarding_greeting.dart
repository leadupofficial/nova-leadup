import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../app/providers.dart';
import '../../core/voice/device_tts.dart';
import 'onboarding_service.dart';

/// The spoken welcome NOVA gives once onboarding is finished.
///
/// Onboarding ends on the health step, which used to flip the status and drop the
/// user on `/login` in silence even though they had just chosen a speech style.
/// The greeting is spoken by the *device* engine ([DeviceTts]) on purpose:
/// onboarding runs before sign-in, so the server-side voice has no session to
/// use and no account to bill, while the platform engine needs neither.
///
/// It is delivered exactly once. Completion can be reached more than once (a
/// resumed run, a double tap on Finish), so "spoken" is a persisted flag rather
/// than an in-memory one.

/// Greeting copy per speech style, written in the language's own script.
///
/// `auto` is resolved separately in [greetingForPolicy]; it is deliberately not
/// a key here.
const Map<String, String> kGreetingTextByPolicy = <String, String>{
  'en': "Hi, I'm NOVA. I'm ready when you are.",
  'ta': 'வணக்கம்! நான் நோவா. உங்களுக்கு உதவ தயாராக இருக்கிறேன்.',
  'tanglish': 'Vanakkam! Naan NOVA. Ungalukku udhava thayaaraaga irukken.',
};

/// The text to say and the BCP-47 voice to say it in.
@immutable
class GreetingScript {
  const GreetingScript({required this.text, required this.languageTag});

  final String text;

  /// BCP-47 tag, or null for "the device default voice".
  final String? languageTag;
}

/// Resolves the greeting for [languagePolicy] (`NovaPersona.languagePolicy`).
///
/// A fixed policy picks its own script. Anything else — `auto`, or a policy NOVA
/// has no greeting for — follows the device's own language when it is one NOVA
/// speaks, and English otherwise: NOVA's interface and its other onboarding copy
/// are English, so that is the honest default rather than a guess.
///
/// The voice tag always comes from [resolveDeviceLanguageTag], the same
/// script-detection helper the realtime device fallback uses, so the greeting and
/// a spoken reply can never disagree about which voice is "correct".
GreetingScript greetingForPolicy({
  required String? languagePolicy,
  String? deviceLanguageCode,
}) {
  final policy = (languagePolicy ?? 'auto').trim().toLowerCase();
  final fixed = kGreetingTextByPolicy[policy];
  if (fixed != null) {
    return GreetingScript(
      text: fixed,
      languageTag: resolveDeviceLanguageTag(
        languagePolicy: policy,
        text: fixed,
      ),
    );
  }

  final device = (deviceLanguageCode ?? '').trim().toLowerCase();
  final chosen = kGreetingTextByPolicy[device == 'ta' ? 'ta' : 'en']!;
  return GreetingScript(
    text: chosen,
    languageTag: resolveDeviceLanguageTag(
      languagePolicy: policy,
      text: chosen,
    ),
  );
}

/// What happened when the greeting was attempted.
enum GreetingOutcome {
  /// The greeting was handed to the device engine.
  spoken,

  /// It had already been spoken on this install.
  alreadySpoken,

  /// The device has no voice for the chosen language, so nothing was said.
  noDeviceVoice,

  /// The engine refused or failed. Nothing was said and the flag is unset.
  failed,
}

@immutable
class GreetingResult {
  const GreetingResult(this.outcome, {this.languageTag, this.notice});

  final GreetingOutcome outcome;

  /// The voice that was used, or that was missing, when known.
  final String? languageTag;

  /// A one-line explanation for the UI, or null when there is nothing to say.
  final String? notice;

  bool get spoken => outcome == GreetingOutcome.spoken;
}

/// Speaks the completion greeting at most once per install.
class OnboardingGreeting {
  OnboardingGreeting({
    required this.preferences,
    required this.tts,
    required this.onboarding,
  });

  /// Persisted "already greeted" flag.
  static const String spokenKey = 'nova_onboarding_greeting_spoken';

  final SharedPreferences preferences;
  final DeviceTts tts;
  final OnboardingService onboarding;

  bool _inFlight = false;

  /// Speaks the greeting for the user's chosen language, or does nothing if it
  /// has already been spoken.
  ///
  /// Never throws: a synthesiser failure must not fail the last onboarding step.
  Future<GreetingResult> speakOnce({String? deviceLanguageCode}) async {
    if (preferences.getBool(spokenKey) ?? false) {
      return const GreetingResult(GreetingOutcome.alreadySpoken);
    }
    if (_inFlight) {
      // Two completion callbacks in the same frame must not both start talking.
      return const GreetingResult(GreetingOutcome.alreadySpoken);
    }
    _inFlight = true;
    try {
      final script = greetingForPolicy(
        languagePolicy: onboarding.getLanguagePolicy(),
        deviceLanguageCode: deviceLanguageCode,
      );
      final tag = script.languageTag;
      if (tag != null && !await tts.canSpeak(tag)) {
        // Nothing was said, so the flag stays unset: the greeting is still owed
        // if the voice is installed later.
        return GreetingResult(
          GreetingOutcome.noDeviceVoice,
          languageTag: tag,
          notice:
              'This device has no $tag voice installed, so NOVA could not say '
              'hello out loud.',
        );
      }
      // Set before speaking so a crash mid-utterance cannot repeat it.
      await preferences.setBool(spokenKey, true);
      await tts.speak(script.text, languageTag: tag);
      return GreetingResult(GreetingOutcome.spoken, languageTag: tag);
    } catch (error) {
      debugPrint('[OnboardingGreeting] could not speak the greeting: $error');
      return const GreetingResult(
        GreetingOutcome.failed,
        notice: 'NOVA could not say hello out loud.',
      );
    } finally {
      _inFlight = false;
    }
  }
}

/// The app-wide completion greeting.
///
/// The [DeviceTts] instance is owned (and disposed) by [deviceTtsProvider]; this
/// provider only borrows it.
final onboardingGreetingProvider = Provider<OnboardingGreeting>((ref) {
  return OnboardingGreeting(
    preferences: ref.watch(sharedPreferencesProvider),
    tts: ref.watch(deviceTtsProvider),
    onboarding: ref.watch(onboardingServiceProvider),
  );
});
