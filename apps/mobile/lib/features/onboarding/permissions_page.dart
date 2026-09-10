import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/permissions/permission_provider.dart';
import '../../core/theme/nova_theme.dart';
import '../../core/avatar/avatar_provider.dart';
import '../../core/design/widgets/index.dart';

class PermissionsPage extends ConsumerStatefulWidget {
 const PermissionsPage({super.key});

 @override
 ConsumerState<PermissionsPage> createState() => _PermissionsPageState();
}

class _PermissionsPageState extends ConsumerState<PermissionsPage> {
 bool _isRequesting = false;

 Future<void> _requestPermission(
 NovaPermissionStatus current,
 Future<NovaPermissionStatus> Function() requestFn,
 ) async {
 if (_isRequesting) return;
 if (current == NovaPermissionStatus.granted) return;

 setState(() => _isRequesting = true);
 final status = await requestFn();
 setState(() => _isRequesting = false);

 if (status == NovaPermissionStatus.permanentlyDenied && mounted) {
 await _showSettingsSnack();
 }
 }

 Future<void> _showSettingsSnack() async {
 if (!mounted) return;
 ScaffoldMessenger.of(context).showSnackBar(
 SnackBar(
 content: const Text('Please enable in Settings'),
 action: SnackBarAction(
 label: 'Open',
 onPressed: () => ref.read(permissionProvider.notifier).openAppSettings(),
 ),
 ),
 );
 }

 void _continueToHome() {
 context.go('/');
 }

 @override
 Widget build(BuildContext context) {
 final permissions = ref.watch(permissionProvider);

 return Scaffold(
 appBar: AppBar(
 title: const Text('Permissions'),
 backgroundColor: Colors.transparent,
 ),
 body: ListView(
 padding: const EdgeInsets.all(24),
 children: [
 const SizedBox(height: 32),
 const NovaAvatar(state: AvatarState.idle, size: 120),
 const SizedBox(height: 24),
 Text(
 'NOVA needs a few permissions',
 style: Theme.of(context).textTheme.headlineSmall?.copyWith(
 fontWeight: FontWeight.bold,
 ),
 textAlign: TextAlign.center,
 ),
 const SizedBox(height: 8),
 Text(
 'Tap each item below to grant access',
 style: Theme.of(context).textTheme.bodyMedium?.copyWith(
 color: NovaTheme.onSurfaceVariant,
 ),
 textAlign: TextAlign.center,
 ),
 const SizedBox(height: 32),
 _PermissionTile(
 icon: Icons.mic_rounded,
 label: 'Microphone',
 description: 'To listen to your voice',
 status: permissions.mic,
 onTap: _isRequesting
 ? null
 : () => _requestPermission(
 permissions.mic,
 ref.read(permissionProvider.notifier).requestMicrophone,
 ),
 ),
 const SizedBox(height: 12),
 _PermissionTile(
 icon: Icons.notifications_rounded,
 label: 'Notifications',
 description: 'To send reminders and alerts',
 status: permissions.notification,
 onTap: _isRequesting
 ? null
 : () => _requestPermission(
 permissions.notification,
 ref.read(permissionProvider.notifier).requestNotification,
 ),
 ),
 const SizedBox(height: 12),
 _PermissionTile(
 icon: Icons.alarm_rounded,
 label: 'Alarms & Reminders',
 description: 'To fire reminders on time',
 status: permissions.alarm,
 onTap: _isRequesting
 ? null
 : () => _requestPermission(
 permissions.alarm,
 ref.read(permissionProvider.notifier).requestAlarm,
 ),
 ),
 const SizedBox(height: 32),
 FilledButton(
 onPressed: permissions.mic == NovaPermissionStatus.granted
 ? _continueToHome
 : null,
 style: FilledButton.styleFrom(
 minimumSize: const Size.fromHeight(56),
 ),
 child: const Text('Continue'),
 ),
 const SizedBox(height: 12),
 TextButton(
 onPressed: () => context.go('/'),
 child: const Text('Skip for now'),
 ),
 ],
 ),
 );
 }
}

class _PermissionTile extends StatelessWidget {
 final IconData icon;
 final String label;
 final String description;
 final NovaPermissionStatus status;
 final VoidCallback? onTap;

 const _PermissionTile({
 required this.icon,
 required this.label,
 required this.description,
 required this.status,
 this.onTap,
 });

 @override
 Widget build(BuildContext context) {
 Color statusColor;
 String statusLabel;
 switch (status) {
 case NovaPermissionStatus.granted:
 statusColor = NovaTheme.success;
 statusLabel = 'Granted';
 break;
 case NovaPermissionStatus.permanentlyDenied:
 statusColor = NovaTheme.error;
 statusLabel = 'Blocked';
 break;
 case NovaPermissionStatus.denied:
 statusColor = NovaTheme.onSurfaceVariant;
 statusLabel = 'Denied';
 break;
 default:
 statusColor = NovaTheme.onSurfaceVariant;
 statusLabel = 'Not set';
 }

 return InkWell(
 onTap: onTap,
 borderRadius: BorderRadius.circular(16),
 child: Container(
 padding: const EdgeInsets.all(16),
 decoration: BoxDecoration(
 color: NovaTheme.surface,
 borderRadius: BorderRadius.circular(16),
 border: Border.all(color: NovaTheme.border),
 ),
 child: Row(
 children: [
 Container(
 width: 40,
 height: 40,
 decoration: BoxDecoration(
 color: NovaTheme.primary.withValues(alpha: 0.15),
 borderRadius: BorderRadius.circular(12),
 ),
 child: Icon(icon, color: NovaTheme.primary, size: 22),
 ),
 const SizedBox(width: 16),
 Expanded(
 child: Column(
 crossAxisAlignment: CrossAxisAlignment.start,
 children: [
 Text(
 label,
 style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15),
 ),
 const SizedBox(height: 2),
 Text(
 description,
 style: TextStyle(
 color: NovaTheme.onSurfaceVariant,
 fontSize: 13,
 ),
 ),
 ],
 ),
 ),
 Container(
 padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
 decoration: BoxDecoration(
 color: statusColor.withValues(alpha: 0.15),
 borderRadius: BorderRadius.circular(20),
 ),
 child: Text(
 statusLabel,
 style: TextStyle(
 color: statusColor,
 fontSize: 12,
 fontWeight: FontWeight.w600,
 ),
 ),
 ),
 ],
 ),
 ),
 );
 }
}
