import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

enum AvatarState {
  idle,
  listening,
  thinking,
  speaking,
  sleeping,
  alert,
}

class AvatarStateNotifier extends AsyncNotifier<AvatarState> {
  @override
  FutureOr<AvatarState> build() async {
    return AvatarState.idle;
  }

  Future<void> setState(AvatarState newState) async {
    state = AsyncData(newState);
  }
}

final avatarStateProvider =
    AsyncNotifierProvider<AvatarStateNotifier, AvatarState>(() {
  return AvatarStateNotifier();
});

class NovaAvatar extends StatelessWidget {
  final AvatarState state;
  final double size;

  const NovaAvatar({
    super.key,
    required this.state,
    this.size = 120,
  });

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(
            colors: [
              const Color(0xFF6366F1).withValues(alpha: 0.8),
              const Color(0xFF06B6D4).withValues(alpha: 0.3),
              Colors.transparent,
            ],
          ),
          boxShadow: [
            BoxShadow(
              color: const Color(0xFF6366F1).withValues(alpha: 0.4),
              blurRadius: 24,
              spreadRadius: 4,
            ),
          ],
        ),
        child: Icon(
          Icons.auto_awesome,
          size: size * 0.45,
          color: Colors.white,
        ),
      ),
    );
  }
}
