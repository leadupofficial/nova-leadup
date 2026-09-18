import 'package:flutter_riverpod/legacy.dart';
import 'package:permission_handler/permission_handler.dart' as ph;

enum NovaPermissionStatus {
  notDetermined,
  granted,
  denied,
  permanentlyDenied,
  restricted,
}

extension PermissionStatusMapper on ph.PermissionStatus {
  NovaPermissionStatus toNovaStatus() {
    switch (this) {
      case ph.PermissionStatus.granted:
      case ph.PermissionStatus.limited:
      case ph.PermissionStatus.provisional:
        return NovaPermissionStatus.granted;
      case ph.PermissionStatus.permanentlyDenied:
        return NovaPermissionStatus.permanentlyDenied;
      case ph.PermissionStatus.restricted:
        return NovaPermissionStatus.restricted;
      case ph.PermissionStatus.denied:
        return NovaPermissionStatus.denied;
    }
  }
}

class NovaPermissionsState {
  final NovaPermissionStatus mic;
  final NovaPermissionStatus notification;
  final NovaPermissionStatus alarm;

  const NovaPermissionsState({
    this.mic = NovaPermissionStatus.notDetermined,
    this.notification = NovaPermissionStatus.notDetermined,
    this.alarm = NovaPermissionStatus.notDetermined,
  });

  NovaPermissionsState copyWith({
    NovaPermissionStatus? mic,
    NovaPermissionStatus? notification,
    NovaPermissionStatus? alarm,
  }) {
    return NovaPermissionsState(
      mic: mic ?? this.mic,
      notification: notification ?? this.notification,
      alarm: alarm ?? this.alarm,
    );
  }
}

class PermissionNotifier extends StateNotifier<NovaPermissionsState> {
  PermissionNotifier() : super(const NovaPermissionsState()) {
    checkInitialPermissions();
  }

  /// The constructor kicks off this check, so it can still be in flight when the
  /// permissions page is popped. Assigning `state` on a disposed `StateNotifier`
  /// throws "Tried to use PermissionNotifier after `dispose` was called", which is why
  /// every mutation below is guarded by [mounted].
  Future<void> checkInitialPermissions() async {
    final micStatus = await ph.Permission.microphone.status;
    final notifStatus = await ph.Permission.notification.status;
    final alarmStatus = await ph.Permission.scheduleExactAlarm.status;
    if (!mounted) return;

    state = state.copyWith(
      mic: micStatus.toNovaStatus(),
      notification: notifStatus.toNovaStatus(),
      alarm: alarmStatus.toNovaStatus(),
    );
  }

  Future<NovaPermissionStatus> requestMicrophone() async {
    final status = await ph.Permission.microphone.request();
    final novaStatus = status.toNovaStatus();
    if (mounted) state = state.copyWith(mic: novaStatus);
    return novaStatus;
  }

  /// Explicitly requests notification permission.
  /// On Android 13+ (API 33+), this triggers the OS dialog for POST_NOTIFICATIONS.
  Future<NovaPermissionStatus> requestNotification() async {
    final status = await ph.Permission.notification.request();
    final novaStatus = status.toNovaStatus();
    if (mounted) state = state.copyWith(notification: novaStatus);
    return novaStatus;
  }

  Future<NovaPermissionStatus> requestAlarm() async {
    final status = await ph.Permission.scheduleExactAlarm.request();
    final novaStatus = status.toNovaStatus();
    if (mounted) state = state.copyWith(alarm: novaStatus);
    return novaStatus;
  }

  Future<void> openAppSettings() async {
    await ph.openAppSettings();
  }
}

final permissionProvider =
    StateNotifierProvider<PermissionNotifier, NovaPermissionsState>((ref) {
  return PermissionNotifier();
});
