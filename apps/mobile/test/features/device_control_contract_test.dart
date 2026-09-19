import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/features/device_control/device_control_models.dart';
import 'package:nova_mobile/features/device_control/device_control_platform.dart';

/// Cross-language contract tests for device control.
///
/// A Dart-only test cannot prove Android performs an action, but it *can* prove
/// the three registries agree on the things that silently break: the channel
/// name, every action's wire id, and every action's permission level. Drift here
/// is the failure mode that actually bites — a renamed action would be accepted
/// by Dart and rejected by Kotlin, and a level changed on one side only would
/// make the confirmation gate disagree with itself.
///
/// The names read here are exactly the ones the native code uses:
///   * `android/app/src/main/java/com/leadup/nova/DeviceControlCatalog.kt`
///   * `android/app/src/main/java/com/leadup/nova/NovaDeviceControl.kt`
///   * `services/api/src/services/assistant-tools.ts`
void main() {
  final kotlinCatalog = File(
    'android/app/src/main/java/com/leadup/nova/DeviceControlCatalog.kt',
  );
  final kotlinPlugin = File(
    'android/app/src/main/java/com/leadup/nova/NovaDeviceControl.kt',
  );
  final apiTools = File(
    '../../services/api/src/services/assistant-tools.ts',
  );

  late final String catalog = kotlinCatalog.readAsStringSync();
  late final String plugin = kotlinPlugin.readAsStringSync();
  late final String tools = apiTools.readAsStringSync();

  /// `LEVEL_*` constants → their integer value, from a Kotlin or TS source.
  Map<String, int> levelConstants(String source, String prefix) {
    final pattern = RegExp('$prefix([A-Z_]+) = (\\d)');
    return <String, int>{
      for (final match in pattern.allMatches(source))
        match.group(1)!: int.parse(match.group(2)!),
    };
  }

  test('the Kotlin files exist where the Dart platform expects them', () {
    expect(kotlinCatalog.existsSync(), isTrue);
    expect(kotlinPlugin.existsSync(), isTrue);
    expect(apiTools.existsSync(), isTrue);
  });

  test('the MethodChannel name matches on both sides', () {
    expect(plugin, contains(MethodChannelDeviceControlPlatform.channelName));
    expect(plugin, contains('METHOD_CHANNEL_NAME = "nova/device_control"'));
  });

  test('the Kotlin action ids match the Dart registry exactly', () {
    final enumBody = RegExp(
      r'enum class Action\([^)]*\)\s*\{(.*?)\}',
      dotAll: true,
    ).firstMatch(catalog)!.group(1)!;
    final kotlinIds = RegExp(r'(\w+)\("([a-z_]+)"\)')
        .allMatches(enumBody)
        .map((RegExpMatch m) => m.group(2)!)
        .toSet();

    expect(
      kotlinIds,
      DeviceAction.values.map((DeviceAction a) => a.wireName).toSet(),
    );
  });

  test('the Kotlin permission levels match the Dart registry exactly', () {
    final levels = levelConstants(catalog, r'const val LEVEL_');
    final body = RegExp(
      r'val LEVELS: Map<Action, Int> = mapOf\((.*?)\)',
      dotAll: true,
    ).firstMatch(catalog)!.group(1)!;

    final kotlinLevels = <String, int>{};
    for (final match in RegExp(r'Action\.(\w+) to LEVEL_(\w+)').allMatches(body)) {
      final actionId = RegExp(r'(\w+)\("([a-z_]+)"\)')
          .allMatches(
            RegExp(
              r'enum class Action\([^)]*\)\s*\{(.*?)\}',
              dotAll: true,
            ).firstMatch(catalog)!.group(1)!,
          )
          .firstWhere((RegExpMatch m) => m.group(1) == match.group(1))
          .group(2)!;
      kotlinLevels[actionId] = levels[match.group(2)]!;
    }

    for (final action in DeviceAction.values) {
      expect(
        kotlinLevels[action.wireName],
        DeviceControlLevels.levelOf(action),
        reason: 'level disagreement for ${action.wireName}',
      );
    }
    expect(kotlinLevels.keys.toSet(), DeviceControlLevels.levels.keys
        .map((DeviceAction a) => a.wireName)
        .toSet());
  });

  test('the API device-tool levels match the Dart registry exactly', () {
    final tsLevels = levelConstants(tools, r'export const TOOL_LEVEL_');
    final body = RegExp(
      r'export const DEVICE_CONTROL_TOOL_LEVELS = \{(.*?)\} as const',
      dotAll: true,
    ).firstMatch(tools)!.group(1)!;

    final apiLevels = <String, int>{};
    for (final match in RegExp(r'(\w+):\s*TOOL_LEVEL_(\w+)').allMatches(body)) {
      apiLevels[match.group(1)!] = tsLevels[match.group(2)]!;
    }

    expect(apiLevels, isNotEmpty);
    for (final action in DeviceAction.values) {
      expect(
        apiLevels[action.wireName],
        DeviceControlLevels.levelOf(action),
        reason: 'API level disagreement for ${action.wireName}',
      );
    }
  });

  test('the Kotlin settings-panel ids match the Dart registry exactly', () {
    final body = RegExp(
      r'enum class SettingsPanel\([^)]*\)\s*\{(.*?)\n    \}',
      dotAll: true,
    ).firstMatch(catalog)!.group(1)!;
    final kotlinPanels = RegExp(r'(\w+)\("([a-z_]+)"')
        .allMatches(body)
        .map((RegExpMatch m) => m.group(2)!)
        .toSet();

    expect(
      kotlinPanels,
      DeviceSettingsPanel.values.map((DeviceSettingsPanel p) => p.wireName).toSet(),
    );
  });

  test('every Kotlin outcome code is one Dart understands', () {
    final kotlinCodes = RegExp(r'const val CODE_\w+ = "(\w+)"')
        .allMatches(plugin)
        .map((RegExpMatch m) => m.group(1)!)
        .toSet();
    final dartCodes = DeviceOutcomeCode.values
        .map((DeviceOutcomeCode c) => c.wireName)
        .toSet();

    expect(kotlinCodes, isNotEmpty);
    expect(
      dartCodes.containsAll(kotlinCodes),
      isTrue,
      reason: 'Kotlin codes $kotlinCodes must all be decodable in Dart',
    );
    // The shared vocabulary, pinned so neither side can rename one silently.
    expect(
      kotlinCodes,
      <String>{
        'ok',
        'unsupported',
        'permission_denied',
        'app_not_found',
        'no_active_session',
        'invalid_argument',
        'failed',
      },
    );
  });

  test('the plugin implements every method the Dart requests name', () {
    for (final request in <DeviceActionRequest>[
      const DeviceActionRequest.openApp('com.whatsapp'),
      const DeviceActionRequest.openDeepLink('https://x.test'),
      const DeviceActionRequest.openPanel(DeviceSettingsPanel.wifi),
      const DeviceActionRequest.dial('123'),
      const DeviceActionRequest.brightness(0.5),
      const DeviceActionRequest.dnd(true),
      const DeviceActionRequest(DeviceAction.mediaNext),
    ]) {
      expect(
        plugin,
        contains('"${request.method}" ->'),
        reason: '${request.method} must be handled in NovaDeviceControl.kt',
      );
    }
  });

  test('the manifest declares only permissions Android can grant here', () {
    final manifest = File(
      'android/app/src/main/AndroidManifest.xml',
    ).readAsStringSync();

    // The two special accesses the feature genuinely uses.
    expect(manifest, contains('android.permission.WRITE_SETTINGS'));
    expect(manifest, contains('android.permission.ACCESS_NOTIFICATION_POLICY'));

    // Things a third-party app cannot be granted, or that the spec excludes.
    for (final forbidden in <String>[
      'android.permission.CALL_PHONE',
      'android.permission.ANSWER_PHONE_CALLS',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.CHANGE_WIFI_STATE',
      'android.permission.WRITE_SECURE_SETTINGS',
      'android.permission.QUERY_ALL_PACKAGES',
      'android.permission.PACKAGE_USAGE_STATS',
      'android.permission.MEDIA_CONTENT_CONTROL',
      'android.permission.SEND_SMS',
    ]) {
      expect(
        manifest,
        isNot(contains(forbidden)),
        reason: '$forbidden must not be declared',
      );
    }

    // No Accessibility service may exist anywhere in the app.
    final serviceFiles = Directory(
      'android/app/src/main/java/com/leadup/nova',
    ).listSync().whereType<File>().where(
      (File f) => f.path.endsWith('.kt'),
    );
    for (final file in serviceFiles) {
      expect(
        file.readAsStringSync(),
        isNot(contains('AccessibilityService')),
        reason: '${file.path} must not declare an Accessibility service',
      );
    }
  });
}
