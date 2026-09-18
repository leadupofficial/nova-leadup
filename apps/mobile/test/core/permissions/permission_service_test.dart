import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:nova_mobile/core/permissions/permission_service.dart';

const _channel = MethodChannel('flutter.baseflow.com/permissions/methods');

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late PermissionService service;

  setUp(() {
    service = PermissionService();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (MethodCall call) {
      switch (call.method) {
        case 'checkPermissionStatus':
          return Future.value(1);
        case 'requestPermissions':
          return Future.value(<int, int>{1: 1});
        case 'openAppSettings':
          return Future.value(true);
        default:
          return Future.value(null);
      }
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
  });

  group('PermissionService', () {
    test('request returns PermissionStatus for microphone', () async {
      final result = await service.request(Permission.microphone);
      expect(result, isA<PermissionStatus>());
    });

    test('request returns PermissionStatus for notifications', () async {
      final result = await service.request(Permission.notification);
      expect(result, isA<PermissionStatus>());
    });

    test('request returns PermissionStatus for storage', () async {
      final result = await service.request(Permission.storage);
      expect(result, isA<PermissionStatus>());
    });

    test('check returns PermissionStatus for microphone', () async {
      final result = await service.check(Permission.microphone);
      expect(result, isA<PermissionStatus>());
    });

    test('check returns PermissionStatus for notifications', () async {
      final result = await service.check(Permission.notification);
      expect(result, isA<PermissionStatus>());
    });

    test('check returns PermissionStatus for storage', () async {
      final result = await service.check(Permission.storage);
      expect(result, isA<PermissionStatus>());
    });

    test('requestMultiple returns a map of statuses', () async {
      final result = await service.requestMultiple([
        Permission.microphone,
        Permission.notification,
        Permission.storage,
      ]);
      expect(result, isA<Map<Permission, PermissionStatus>>());
      expect(result.values.every((s) => s.isGranted), isTrue);
    });

    test('allGranted returns true when all permissions are granted',
        () async {
      final result = await service.allGranted([
        Permission.microphone,
        Permission.notification,
        Permission.storage,
      ]);
      expect(result, isA<bool>());
    });

    test('openSettings returns a Future<void>', () async {
      final result = service.openSettings();
      expect(result, isA<Future<void>>());
      await result;
    });

    test('provider creates a PermissionService instance', () {
      final container = ProviderContainer();
      final service = container.read(permissionServiceProvider);
      expect(service, isA<PermissionService>());
      container.dispose();
    });
  });
}
