import 'dart:async';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:permission_handler/permission_handler.dart';

class PermissionService {
  Future<PermissionStatus> request(Permission permission) async {
    return await permission.request();
  }

  Future<PermissionStatus> check(Permission permission) async {
    return await permission.status;
  }

  Future<Map<Permission, PermissionStatus>> requestMultiple(
    List<Permission> permissions,
  ) async {
    return await permissions.request();
  }

  Future<bool> allGranted(List<Permission> permissions) async {
    for (final p in permissions) {
      final s = await p.status;
      if (!s.isGranted) return false;
    }
    return true;
  }

  Future<void> openSettings() async {
    await openAppSettings();
  }
}

final permissionServiceProvider = Provider<PermissionService>((ref) {
  return PermissionService();
});
