import 'package:flutter/foundation.dart';

/// A side-effecting tool the realtime voice server is waiting to run.
///
/// Mirrors an `approval_request` frame: the server has paused the turn and will
/// not execute the tool until an answer arrives for [approvalId] — and never
/// executes it if one does not. Every field the confirmation sheet renders is
/// carried here, so the sheet shows the payload the server will run rather than
/// a local reconstruction of it.
@immutable
class VoiceToolApproval {
  const VoiceToolApproval({
    required this.approvalId,
    required this.turnId,
    required this.tool,
    required this.permissionLevel,
    required this.summary,
    required this.input,
    this.expiresAt,
  });

  /// Unique per request; echoed on the response.
  final String approvalId;

  /// The turn that asked, echoed on the response so the server can drop an
  /// answer that arrived after its turn ended.
  final int turnId;

  /// Tool name, e.g. `create_reminder`.
  final String tool;

  /// Permission level 0–3 from the server's registry.
  final int permissionLevel;

  /// The server's one-line statement of exactly what will happen.
  final String summary;

  /// The resolved arguments, verbatim.
  final Map<String, dynamic> input;

  /// When the request stops being answerable, if the server said.
  final DateTime? expiresAt;

  /// True for the permission levels that communicate outside the user's own
  /// account — the ones that need the full payload on screen.
  bool get isExternal => permissionLevel >= 2;

  /// The plain-language consequence, since the sheet's default wording talks
  /// about "external actions" and an L1 reminder is nothing of the sort.
  String get consequence => switch (tool) {
    'create_reminder' => 'A reminder will be added to your reminders.',
    'create_task' => 'A task will be added to your task list.',
    'save_memory' => 'This will be saved to what NOVA remembers about you.',
    _ when isExternal =>
      'This action reaches outside your account and cannot be recalled.',
    _ => 'This action will be carried out on your account.',
  };

  @override
  bool operator ==(Object other) =>
      other is VoiceToolApproval &&
      other.approvalId == approvalId &&
      other.turnId == turnId &&
      other.tool == tool &&
      other.permissionLevel == permissionLevel &&
      other.summary == summary &&
      other.expiresAt == expiresAt &&
      mapEquals(other.input, input);

  @override
  int get hashCode => Object.hash(
    approvalId,
    turnId,
    tool,
    permissionLevel,
    summary,
    expiresAt,
    Object.hashAllUnordered(input.entries.map((e) => Object.hash(e.key, e.value))),
  );

  @override
  String toString() =>
      'VoiceToolApproval($tool, level $permissionLevel, id $approvalId)';
}
