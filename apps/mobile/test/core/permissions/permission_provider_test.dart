import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/core/permissions/permission_provider.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

const _channel = MethodChannel('flutter.baseflow.com/permissions/methods');

/// permission_handler's native status codes.
const int _denied = 0;
const int _granted = 1;
const int _permanentlyDenied = 4;

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Map<int, int> statuses = <int, int>{};
  var openAppSettingsCalls = 0;

  setUp(() {
    statuses = <int, int>{};
    openAppSettingsCalls = 0;

    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (MethodCall call) async {
      switch (call.method) {
        case 'checkPermissionStatus':
          final index = call.arguments as int;
          return statuses[index] ?? _denied;
        case 'requestPermissions':
          final indices = (call.arguments as List<dynamic>).cast<int>();
          return <int, int>{for (final index in indices) index: statuses[index] ?? _denied};
        case 'shouldShowRequestPermissionRationale':
          return false;
        case 'openAppSettings':
          openAppSettingsCalls++;
          return true;
        default:
          return null;
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  /// Builds a notifier and waits for the initial check its constructor starts.
  Future<PermissionNotifier> buildNotifier() async {
    final notifier = PermissionNotifier();
    addTearDown(notifier.dispose);
    await pumpEventQueue();
    return notifier;
  }

  test('maps native statuses onto NovaPermissionStatus', () async {
    statuses = <int, int>{
      ph.Permission.microphone.value: _granted,
      ph.Permission.notification.value: _granted,
      ph.Permission.scheduleExactAlarm.value: _permanentlyDenied,
    };

    final notifier = await buildNotifier();

    expect(notifier.state.mic, NovaPermissionStatus.granted);
    expect(notifier.state.notification, NovaPermissionStatus.granted);
    // The mapping must not collapse "blocked" into "denied": the UI only offers an
    // Open-Settings action for permanently denied.
    expect(notifier.state.alarm, NovaPermissionStatus.permanentlyDenied);
  });

  test('requestMicrophone transitions state and returns the new status', () async {
    statuses = <int, int>{ph.Permission.microphone.value: _denied};
    final notifier = await buildNotifier();
    expect(notifier.state.mic, NovaPermissionStatus.denied);

    statuses[ph.Permission.microphone.value] = _granted;
    final result = await notifier.requestMicrophone();

    expect(result, NovaPermissionStatus.granted);
    expect(notifier.state.mic, NovaPermissionStatus.granted);
  });

  test('requestNotification maps a permanent denial', () async {
    statuses = <int, int>{ph.Permission.notification.value: _permanentlyDenied};

    final notifier = await buildNotifier();
    final result = await notifier.requestNotification();

    expect(result, NovaPermissionStatus.permanentlyDenied);
    expect(notifier.state.notification, NovaPermissionStatus.permanentlyDenied);
  });

  test('requestAlarm leaves the other permission slots untouched', () async {
    statuses = <int, int>{
      ph.Permission.microphone.value: _denied,
      ph.Permission.notification.value: _denied,
      ph.Permission.scheduleExactAlarm.value: _denied,
    };
    final notifier = await buildNotifier();

    statuses[ph.Permission.scheduleExactAlarm.value] = _granted;
    await notifier.requestAlarm();

    expect(notifier.state.alarm, NovaPermissionStatus.granted);
    expect(notifier.state.mic, NovaPermissionStatus.denied);
    expect(notifier.state.notification, NovaPermissionStatus.denied);
  });

  test('openAppSettings reaches the platform', () async {
    final notifier = await buildNotifier();

    await notifier.openAppSettings();

    expect(openAppSettingsCalls, 1);
  });

  test('disposing while the initial check is in flight does not throw', () async {
    // Regression test: the constructor starts an async check, so assigning `state`
    // after disposal used to raise
    // "Bad state: Tried to use PermissionNotifier after `dispose` was called".
    final notifier = PermissionNotifier();
    notifier.dispose();

    await pumpEventQueue();
  });

  test('the provider exposes the notifier state and reacts to requests', () async {
    statuses = <int, int>{ph.Permission.microphone.value: _denied};

    final container = ProviderContainer();
    addTearDown(container.dispose);

    expect(container.read(permissionProvider).mic, NovaPermissionStatus.notDetermined);
    await pumpEventQueue();
    expect(container.read(permissionProvider).mic, NovaPermissionStatus.denied);

    statuses[ph.Permission.microphone.value] = _granted;
    await container.read(permissionProvider.notifier).requestMicrophone();

    expect(container.read(permissionProvider).mic, NovaPermissionStatus.granted);
  });
}
