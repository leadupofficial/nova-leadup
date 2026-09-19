import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:nova_mobile/core/api/nova_api.dart';
import 'package:nova_mobile/features/device_control/device_control_controller.dart';
import 'package:nova_mobile/features/device_control/device_control_models.dart';
import 'package:nova_mobile/features/device_control/device_control_voice_commands.dart';
import 'package:nova_mobile/features/recording/meeting_recorder.dart';
import 'package:nova_mobile/features/recording/recording_controller.dart';

import '../helpers/fake_device_control_platform.dart';
import '../helpers/fake_meeting_recorder.dart';
import '../helpers/test_harness.dart';

/// Voice-triggered meeting capture.
///
/// The wake-word path cannot dispatch client actions, so the reachable path is
/// the device-control command bar: [matchDeviceVoiceCommand] maps the phrase,
/// the L3 gate raises the consent confirmation, and the controller then drives
/// the recorder **in Dart**. These tests prove the phrase mapping, the levels,
/// and that a confirmed start genuinely records while Android is never asked to
/// do anything.
void main() {
  late List<RequestOptions> captured;

  NovaApi recordingApi() {
    final adapter = FakeHttpAdapter((RequestOptions options) async {
      captured.add(options);
      final path = options.path;
      if (path.endsWith('/audio')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'recording': <String, dynamic>{'id': 'rec-1', 'title': 'Meeting'},
            'storage': <String, dynamic>{'objectStorage': true, 'bytes': 4},
          },
        });
      }
      if (path.endsWith('/process')) {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{
            'recordingId': 'rec-1',
            'status': 'processing',
          },
        }, statusCode: 202);
      }
      if (options.method == 'PATCH') {
        return jsonResponse(<String, dynamic>{
          'success': true,
          'data': <String, dynamic>{'id': 'rec-1', 'status': 'completed'},
        });
      }
      return jsonResponse(<String, dynamic>{
        'success': true,
        'data': <String, dynamic>{
          'id': 'rec-1',
          'title': 'Meeting',
          'status': 'recording',
        },
      }, statusCode: 201);
    });
    return NovaApi(fakeNetworkService(adapter));
  }

  setUp(() => captured = <RequestOptions>[]);

  group('phrases', () {
    test('map to the capture actions, not to an app called "recording"', () {
      for (final phrase in <String>[
        'start recording',
        'start recording this meeting',
        'record this meeting',
      ]) {
        final command = matchDeviceVoiceCommand(phrase)!;
        expect(command.action, DeviceAction.startRecording, reason: phrase);
      }

      for (final phrase in <String>['stop recording', 'stop the recording']) {
        final command = matchDeviceVoiceCommand(phrase)!;
        expect(command.action, DeviceAction.stopRecording, reason: phrase);
      }

      // The generic open-app rule must not swallow "start recording"...
      expect(
        matchDeviceVoiceCommand('start recording')!.action,
        isNot(DeviceAction.openApp),
      );
      // ...while a real app launch still works.
      final app = matchDeviceVoiceCommand('start Maps')!;
      expect(app.action, DeviceAction.openApp);
      expect(app.app, 'Maps');
    });
  });

  group('levels and honesty', () {
    test('starting a recording is L3, stopping it is L1', () {
      expect(
        DeviceControlLevels.levelOf(DeviceAction.startRecording),
        DeviceControlLevels.sensitive,
      );
      expect(
        DeviceControlLevels.levelOf(DeviceAction.stopRecording),
        DeviceControlLevels.lowRiskWrite,
      );
      expect(DeviceControlLevels.requiresConfirmation(DeviceAction.startRecording), isTrue);
      expect(DeviceControlLevels.requiresConfirmation(DeviceAction.stopRecording), isTrue);
    });

    test('the two actions are marked as meeting capture, not media', () {
      expect(DeviceAction.startRecording.isMeetingCapture, isTrue);
      expect(DeviceAction.stopRecording.isMeetingCapture, isTrue);
      expect(DeviceAction.startRecording.isMedia, isFalse);
    });

    test('the confirmation sheet states the consent duty', () {
      const request = DeviceActionRequest(DeviceAction.startRecording);
      expect(request.confirmationSummary, contains('recorded'));
      // The method exists only so a stray call reaches Kotlin's honest refusal.
      expect(request.method, 'startRecording');
      expect(request.platformArguments, isEmpty);
    });
  });

  group('in-app execution', () {
    ProviderContainer container(FakeDeviceControlPlatform platform) {
      final container = ProviderContainer(
        overrides: [
          deviceControlPlatformProvider.overrideWithValue(platform),
          novaApiProvider.overrideWithValue(recordingApi()),
          meetingRecorderProvider.overrideWithValue(
            fakeMeetingRecorder(recorder: FakeAudioRecorder()),
          ),
        ],
      );
      addTearDown(container.dispose);
      return container;
    }

    test('an unconfirmed start is gated and touches nothing', () async {
      final platform = FakeDeviceControlPlatform();
      final c = container(platform);
      final command = matchDeviceVoiceCommand('start recording')!;

      final outcome = await c
          .read(deviceControlProvider.notifier)
          .runMatchedCommand(command);

      expect(outcome!.code, DeviceOutcomeCode.confirmationRequired);
      expect(captured, isEmpty);
      expect(platform.invocations, isEmpty);
      expect(c.read(recordingControllerProvider).phase, RecordingPhase.consent);
    });

    test('a confirmed start really records, in Dart, with no Android intent',
        () async {
      final platform = FakeDeviceControlPlatform();
      final c = container(platform);
      final command = matchDeviceVoiceCommand('record this meeting')!;

      final outcome = await c
          .read(deviceControlProvider.notifier)
          .runMatchedCommand(command, confirmed: true);

      expect(outcome!.ok, isTrue);
      expect(outcome.extras['route'], '/tasks/record');
      expect(c.read(recordingControllerProvider).phase, RecordingPhase.recording);
      expect(c.read(recordingControllerProvider).consentAcknowledged, isTrue);

      // The row was created with the consent record...
      expect(captured.single.path, endsWith('/recordings'));
      expect(
        (captured.single.data as Map<String, dynamic>)['consentRecorded'],
        isTrue,
      );
      // ...and Android was never asked to do anything.
      expect(platform.invocations, isEmpty);
    });

    test('a spoken stop finishes the session and routes to the summary',
        () async {
      final platform = FakeDeviceControlPlatform();
      final c = container(platform);
      final controller = c.read(deviceControlProvider.notifier);

      await controller.runMatchedCommand(
        matchDeviceVoiceCommand('start recording')!,
        confirmed: true,
      );
      final outcome = await controller.runMatchedCommand(
        matchDeviceVoiceCommand('stop the recording')!,
        confirmed: true,
      );

      expect(outcome!.ok, isTrue);
      expect(outcome.extras['route'], '/recordings/rec-1');
      expect(
        c.read(recordingControllerProvider).phase,
        RecordingPhase.processing,
      );
      expect(platform.invocations, isEmpty);
    });

    test('stopping with nothing running says so', () async {
      final c = container(FakeDeviceControlPlatform());

      final outcome = await c
          .read(deviceControlProvider.notifier)
          .runMatchedCommand(
            matchDeviceVoiceCommand('stop recording')!,
            confirmed: true,
          );

      expect(outcome!.ok, isFalse);
      expect(outcome.message, contains('No recording'));
    });
  });
}
