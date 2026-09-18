import 'package:flutter/material.dart';

class NovaTheme {
  static const primary = Color(0xFF6366F1); // Indigo
  static const primaryDark = Color(0xFF4F46E5);
  static const accent = Color(0xFF06B6D4); // Cyan
  static const surface = Color(0xFF1E293B); // Slate 800
  static const surfaceVariant = Color(0xFF334155); // Slate 700
  static const background = Color(0xFF0F172A); // Slate 900
  static const border = Color(0xFF334155);
  static const success = Color(0xFF10B981); // Emerald
  static const error = Color(0xFFEF4444); // Red
  static const warning = Color(0xFFF59E0B); // Amber
  static const onSurfaceVariant = Color(0xFF94A3B8); // Slate 400

  static ThemeData get darkTheme {
    return ThemeData.dark().copyWith(
      scaffoldBackgroundColor: background,
      primaryColor: primary,
      colorScheme: const ColorScheme.dark(
        primary: primary,
        secondary: accent,
        surface: surface,
        error: error,
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
      ),
    );
  }
}
