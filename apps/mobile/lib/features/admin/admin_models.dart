import 'package:flutter/foundation.dart';

/// Wire models for the admin API (`services/api/src/routes/admin.ts`).
///
/// Nothing here is defaulted into existence: every field is parsed from a real
/// response, and a field the server only pretends to compute is left out
/// entirely. `/admin/dashboard` reports `status: 'healthy'` and two passing
/// `checks` as hardcoded literals (`admin.ts:99`), which is why
/// [AdminDashboard] has no `status` field and no code path can render one.
///
/// The reporting endpoint is `/health/ready` instead; see [AdminReadiness].

// ─── Models ───────────────────────────────────────────────────────────────────

DateTime? _date(dynamic value) =>
    value is String ? DateTime.tryParse(value) : null;

/// Coerces a JSON number (or numeric string) to an int. Shared with
/// `admin_api.dart`, which parses the pagination envelope.
int adminInt(dynamic value) => value is num
    ? value.toInt()
    : (value is String ? (int.tryParse(value) ?? 0) : 0);

/// One page of a paginated admin list route.
///
/// The routes answer `{success, data: {data: [...], totalItems, ...}}`. When the
/// server holds more rows than this page carries, [truncated] is true and any
/// count derived from [items] is a lower bound — the UI says so rather than
/// presenting a page count as a total.
@immutable
class AdminList<T> {
  const AdminList({required this.items, required this.totalItems});

  final List<T> items;
  final int totalItems;

  bool get truncated => items.length < totalItems;
}

@immutable
class AdminDashboard {
  const AdminDashboard({
    required this.totalUsers,
    required this.totalOrganizations,
    required this.totalIncidents,
    required this.openIncidents,
    required this.totalFeatureFlags,
  });

  /// The route also returns `status: 'healthy'` and `checks: [{database: pass},
  /// {api: pass}]` as hardcoded literals (`admin.ts:99`), not as the result of a
  /// check. They are deliberately dropped here so nothing can render them as a
  /// health verdict.
  factory AdminDashboard.fromJson(Map<String, dynamic> j) {
    final m = j['metrics'] is Map
        ? Map<String, dynamic>.from(j['metrics'] as Map)
        : const <String, dynamic>{};
    return AdminDashboard(
      totalUsers: adminInt(m['totalUsers']),
      totalOrganizations: adminInt(m['totalOrganizations']),
      totalIncidents: adminInt(m['totalIncidents']),
      openIncidents: adminInt(m['openIncidents']),
      totalFeatureFlags: adminInt(m['totalFeatureFlags']),
    );
  }

  final int totalUsers;
  final int totalOrganizations;
  final int totalIncidents;
  final int openIncidents;
  final int totalFeatureFlags;
}

@immutable
class AdminUser {
  const AdminUser({
    required this.id,
    required this.email,
    required this.name,
    required this.role,
    required this.status,
    required this.disabled,
    required this.emailVerified,
    required this.createdAt,
  });

  /// `role` comes back as the sql literal `'member'` for every row
  /// (`admin.ts:155`), so it is displayed as-is and never aggregated into a
  /// "roles" count.
  factory AdminUser.fromJson(Map<String, dynamic> j) => AdminUser(
    id: (j['id'] ?? '').toString(),
    email: (j['email'] ?? '').toString(),
    name: j['name'] as String?,
    role: (j['role'] ?? 'member').toString(),
    status: (j['status'] ?? 'pending').toString(),
    disabled: j['disabled'] == true,
    emailVerified: j['emailVerified'] == true,
    createdAt: _date(j['createdAt']),
  );

  final String id;
  final String email;
  final String? name;
  final String role;
  final String status;
  final bool disabled;
  final bool emailVerified;
  final DateTime? createdAt;

  String get label => (name == null || name!.trim().isEmpty) ? email : name!;
  bool get isActive => status == 'active';
}

@immutable
class AdminOrganization {
  const AdminOrganization({
    required this.id,
    required this.name,
    required this.slug,
    required this.plan,
    required this.members,
    required this.createdAt,
  });

  factory AdminOrganization.fromJson(Map<String, dynamic> j) =>
      AdminOrganization(
        id: (j['id'] ?? '').toString(),
        name: (j['name'] ?? '').toString(),
        slug: (j['slug'] ?? '').toString(),
        plan: (j['plan'] ?? '').toString(),
        members: adminInt(j['members']),
        createdAt: _date(j['createdAt']),
      );

  final String id;
  final String name;
  final String slug;
  final String plan;
  final int members;
  final DateTime? createdAt;
}

@immutable
class AdminAuditEntry {
  const AdminAuditEntry({
    required this.id,
    required this.action,
    required this.actor,
    required this.outcome,
    required this.targetType,
    required this.occurredAt,
  });

  factory AdminAuditEntry.fromJson(Map<String, dynamic> j) => AdminAuditEntry(
    id: (j['id'] ?? '').toString(),
    action: (j['action'] ?? 'unknown').toString(),
    actor: (j['actor'] ?? 'system').toString(),
    outcome: j['outcome'] as String?,
    targetType: j['targetType'] as String?,
    occurredAt: _date(j['occurredAt']) ?? _date(j['timestamp']),
  );

  final String id;
  final String action;
  final String actor;
  final String? outcome;
  final String? targetType;
  final DateTime? occurredAt;
}

@immutable
class AdminIncident {
  const AdminIncident({
    required this.id,
    required this.severity,
    required this.title,
    required this.description,
    required this.resolved,
    required this.occurredAt,
  });

  factory AdminIncident.fromJson(Map<String, dynamic> j) => AdminIncident(
    id: (j['id'] ?? '').toString(),
    severity: (j['severity'] ?? 'info').toString(),
    title: (j['title'] ?? j['message'] ?? '').toString(),
    description: j['description'] as String?,
    resolved: j['resolved'] == true,
    occurredAt: _date(j['occurredAt']),
  );

  final String id;
  final String severity;
  final String title;
  final String? description;
  final bool resolved;
  final DateTime? occurredAt;
}

@immutable
class AdminUsageSummary {
  const AdminUsageSummary({
    required this.totalCalls,
    required this.totalTokens,
    required this.totalCost,
    required this.period,
  });

  factory AdminUsageSummary.fromJson(Map<String, dynamic> j) =>
      AdminUsageSummary(
        totalCalls: adminInt(j['totalCalls']),
        totalTokens: adminInt(j['totalTokens']),
        // The route derives this as `round(tokens * 0.00002)` and does not name
        // a currency; the sibling web console labels it USD. No currency symbol
        // is printed here for that reason.
        totalCost: adminInt(j['totalCost']),
        period: (j['period'] ?? '30d').toString(),
      );

  final int totalCalls;
  final int totalTokens;
  final int totalCost;
  final String period;
}

@immutable
class AdminHealthCheck {
  const AdminHealthCheck({
    required this.name,
    required this.status,
    required this.latencyMs,
  });

  factory AdminHealthCheck.fromJson(Map<String, dynamic> j) => AdminHealthCheck(
    name: (j['name'] ?? '').toString(),
    status: (j['status'] ?? 'unknown').toString(),
    latencyMs: adminInt(j['latencyMs']),
  );

  final String name;
  final String status;
  final int latencyMs;
}

/// The API's own readiness report from `GET /health/ready`.
@immutable
class AdminReadiness {
  const AdminReadiness({
    required this.status,
    required this.checks,
    required this.up,
    required this.down,
    required this.note,
  });

  /// Rendered when the API answered 503 with `status: 'unhealthy'`. The body is
  /// not reachable through [NetworkService], which turns any 5xx into an
  /// exception, so only the status is known — hence [note].
  const AdminReadiness.unhealthy()
    : status = 'unhealthy',
      checks = const <AdminHealthCheck>[],
      up = 0,
      down = 0,
      note =
          'The API answered 503 on /health/ready, which means at least one '
          'dependency check failed.';

  factory AdminReadiness.fromJson(Map<String, dynamic> j) {
    final rawChecks = j['checks'];
    final summary = j['summary'] is Map
        ? Map<String, dynamic>.from(j['summary'] as Map)
        : const <String, dynamic>{};
    return AdminReadiness(
      status: (j['status'] ?? 'unknown').toString(),
      checks: rawChecks is List
          ? rawChecks
                .whereType<Map>()
                .map(
                  (m) =>
                      AdminHealthCheck.fromJson(Map<String, dynamic>.from(m)),
                )
                .toList()
          : const <AdminHealthCheck>[],
      up: adminInt(summary['up']),
      down: adminInt(summary['down']),
      note: null,
    );
  }

  final String status;
  final List<AdminHealthCheck> checks;
  final int up;
  final int down;
  final String? note;

  /// `services/api/src/utils/health.ts` reports one of `healthy`, `degraded`
  /// or `unhealthy` — a down dependency that still serves is `degraded`, which
  /// is not the same claim as healthy.
  bool get isHealthy => status == 'healthy' || status == 'ok';
  bool get isDegraded => status == 'degraded';
}
