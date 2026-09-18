import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/providers.dart';
import '../../config/api_config.dart';
import '../../core/api/nova_api.dart' show NovaApiException;
import '../../services/network_service.dart';
import '../auth/auth_controller.dart';
import 'admin_models.dart';

/// Admin console data layer.
///
/// This is new surface, not a port. `lib/config/api_config.dart` names no admin
/// route and `lib/core/api/nova_api.dart` has no admin method, because the
/// product's admin surface was built separately in `apps/admin` (Next.js) for the
/// `admin.leadup.in` console. Those endpoints are nevertheless live on the very
/// API this app already talks to — `services/api/src/server.ts:70` mounts
/// `services/api/src/routes/admin.ts` at `/api/v1/admin` — so this file calls
/// them directly through the authenticated [networkServiceProvider] instead of
/// inventing a console.
///
/// Every route here is gated server-side by `requireAdmin`
/// (`routes/admin.ts:32`), which accepts only `owner` and `admin`. That is the
/// real authority; [adminRoleProvider] only decides what the UI shows before the
/// first request goes out.

// ─── Endpoints ────────────────────────────────────────────────────────────────

/// HTTP routes served by `services/api/src/routes/admin.ts`.
class AdminRoutes {
  const AdminRoutes._();

  static String get _root => '${ApiConfig.baseUrl}/api/v1/admin';

  /// `GET /dashboard` (admin.ts:79) — real row counts. The `status: 'healthy'`
  /// and `checks` fields in its payload are hardcoded literals, so they are not
  /// parsed; see [AdminDashboard].
  static String get dashboard => '$_root/dashboard';

  /// `GET /users` (admin.ts:122), paginated `{data, page, pageSize, totalItems}`.
  static String get users => '$_root/users';

  /// `PATCH /users/:id` (admin.ts:233) with `{disabled, emailVerified, name}`.
  static String user(String id) => '$users/$id';

  /// `GET /organizations` (admin.ts:281), paginated.
  static String get organizations => '$_root/organizations';

  /// `GET /audit-logs` (admin.ts:383), paginated, newest first.
  static String get auditLogs => '$_root/audit-logs';

  /// `GET /incidents` (admin.ts:574), paginated.
  static String get incidents => '$_root/incidents';

  /// `POST /incidents/:id/resolve` (admin.ts:676).
  static String resolveIncident(String id) => '$incidents/$id/resolve';

  /// `GET /usage/:tenantId/summary` (admin.ts:715) — a 30-day window. The tenant
  /// id is an organization id, which is why this only runs once an organization
  /// has been listed.
  static String usageSummary(String tenantId) =>
      '$_root/usage/$tenantId/summary';

  /// `GET /health/ready` — mounted at the origin by `server.ts:48`, not under
  /// `/api/v1`. Authenticated, and returns the API's own dependency report
  /// (`services/api/src/routes/health.ts`), which is the only honest health
  /// signal available: it runs the real checks.
  static String get readiness => '${ApiConfig.baseUrl}/health/ready';
}

// ─── API ──────────────────────────────────────────────────────────────────────

class AdminApi {
  AdminApi(this._network);

  final NetworkService _network;

  Future<AdminDashboard> dashboard() async {
    final raw = await _get(AdminRoutes.dashboard);
    return AdminDashboard.fromJson(_asMap(raw));
  }

  /// `limit` is clamped server-side to 100 (`AdminListQuerySchema`), so requesting
  /// more is pointless.
  Future<AdminList<AdminUser>> listUsers({int pageSize = 100}) async {
    final raw = await _get(AdminRoutes.users, query: {'pageSize': pageSize});
    return _page(raw, AdminUser.fromJson);
  }

  /// The only admin mutation the mobile console performs. The route's schema
  /// accepts `disabled`, `emailVerified` and `name`; only [disabled] is sent.
  Future<void> setUserDisabled(String id, {required bool disabled}) =>
      _patch(AdminRoutes.user(id), {'disabled': disabled});

  Future<AdminList<AdminOrganization>> listOrganizations({
    int pageSize = 100,
  }) async {
    final raw = await _get(
      AdminRoutes.organizations,
      query: {'pageSize': pageSize},
    );
    return _page(raw, AdminOrganization.fromJson);
  }

  Future<AdminList<AdminAuditEntry>> listAuditLogs({int pageSize = 20}) async {
    final raw = await _get(
      AdminRoutes.auditLogs,
      query: {'pageSize': pageSize},
    );
    return _page(raw, AdminAuditEntry.fromJson);
  }

  Future<AdminList<AdminIncident>> listIncidents({
    int pageSize = 20,
    bool? resolved,
  }) async {
    final raw = await _get(
      AdminRoutes.incidents,
      query: {'pageSize': pageSize, 'resolved': ?resolved},
    );
    return _page(raw, AdminIncident.fromJson);
  }

  Future<void> resolveIncident(String id) async {
    await _guard(
      () => _network.post<dynamic>(AdminRoutes.resolveIncident(id), data: {}),
    );
  }

  Future<AdminUsageSummary> usageSummary(String tenantId) async {
    final raw = await _get(AdminRoutes.usageSummary(tenantId));
    return AdminUsageSummary.fromJson(_asMap(raw));
  }

  Future<AdminReadiness> readiness() async {
    try {
      final raw = await _guard(
        () => _network.get<dynamic>(AdminRoutes.readiness),
      );
      return AdminReadiness.fromJson(_asMap(raw));
    } on NovaApiException catch (e) {
      // A down dependency is answered as `503` with the report in the body, and
      // `NetworkService` discards that body when it maps the error. Treat 503 as
      // the honest "unhealthy" state; every other status (401/403/404) is a
      // genuine failure and is rethrown.
      if (e.statusCode == 503) return const AdminReadiness.unhealthy();
      rethrow;
    }
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  Future<dynamic> _get(String url, {Map<String, dynamic>? query}) =>
      _guard(() => _network.get<dynamic>(url, queryParameters: query));

  Future<void> _patch(String url, Map<String, dynamic> body) async {
    await _guard(() => _network.patch<dynamic>(url, data: body));
  }

  Future<dynamic> _guard(Future<Response<dynamic>> Function() call) async {
    final Response<dynamic> response;
    try {
      response = await call();
    } on NetworkException catch (e) {
      throw NovaApiException(e.message, statusCode: e.statusCode);
    } on DioException catch (e) {
      throw NovaApiException(
        e.message ?? 'The request failed.',
        statusCode: e.response?.statusCode,
      );
    }
    final raw = response.data;
    if (raw is Map) {
      final body = Map<String, dynamic>.from(raw);
      if (body['success'] == false) {
        throw NovaApiException(
          (body['error'] ?? 'The server rejected the request').toString(),
          statusCode: response.statusCode,
        );
      }
      if (body.containsKey('success')) return body['data'];
    }
    return raw;
  }

  Map<String, dynamic> _asMap(dynamic value) =>
      value is Map ? Map<String, dynamic>.from(value) : const {};

  AdminList<T> _page<T>(dynamic data, T Function(Map<String, dynamic>) parse) {
    List<T> parseRows(dynamic rows) => rows is List
        ? rows
              .whereType<Map>()
              .map((m) => parse(Map<String, dynamic>.from(m)))
              .toList()
        : <T>[];

    if (data is List) {
      final items = parseRows(data);
      return AdminList<T>(items: items, totalItems: items.length);
    }
    if (data is Map) {
      final items = parseRows(data['data']);
      final total = adminInt(data['totalItems']);
      return AdminList<T>(
        items: items,
        totalItems: total == 0 ? items.length : total,
      );
    }
    return AdminList<T>(items: const [], totalItems: 0);
  }
}

// ─── Role gate ────────────────────────────────────────────────────────────────

/// Strips the exception prefix the feature screens render away, so a failure
/// reads as the server's own sentence.
String adminErrorMessage(Object error) =>
    error.toString().replaceFirst(RegExp(r'^NovaApiException\(\d*\): '), '');

/// Roles `requireAdmin` accepts (`services/api/src/routes/admin.ts:34`).
const Set<String> adminRoles = {'owner', 'admin'};

bool isAdminRole(String? role) => role != null && adminRoles.contains(role);

/// Reads the `role` claim out of the stored access token.
///
/// The access token is an HS256 JWT whose payload is `{sub, email, role, jti}`
/// (`services/api/src/utils/tokens.ts`), and it is the *only* place the client
/// ever sees its own role: `GET /api/v1/auth/me` and the login/refresh responses
/// return `toPublicUser()` (`routes/auth.ts:133`), which has no `role` field, and
/// [AuthUser] does not either.
///
/// **This is a decode, not a verification** — the signature cannot be checked
/// without the server secret. It exists so the console renders an honest "owner
/// access required" state instead of firing six doomed requests. It grants
/// nothing: every `/api/v1/admin/*` route re-derives the role from the verified
/// token server-side and answers 403 to anything that is not owner/admin.
String? adminRoleFromAccessToken(String? token) {
  if (token == null) return null;
  final parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    final payload = utf8.decode(
      base64Url.decode(base64Url.normalize(parts[1])),
    );
    final decoded = jsonDecode(payload);
    if (decoded is Map && decoded['role'] is String) {
      return decoded['role'] as String;
    }
  } catch (_) {
    // A malformed token is simply "no role known" — the gate fails closed.
  }
  return null;
}

// ─── Providers ────────────────────────────────────────────────────────────────

final adminApiProvider = Provider<AdminApi>(
  (ref) => AdminApi(ref.watch(networkServiceProvider)),
);

/// The signed-in session's role, taken from the stored access token.
///
/// Watches [authStateProvider] so it recomputes after sign-in, sign-out and the
/// interceptor's transparent token refresh (which rewrites the stored session).
final adminRoleProvider = Provider<String?>((ref) {
  ref.watch(authStateProvider);
  try {
    return adminRoleFromAccessToken(
      ref.read(authRepositoryProvider).currentToken?.accessToken,
    );
  } catch (_) {
    // The repository is override-injected during bootstrap; if it is missing the
    // console cannot establish a role, so it shows the gate.
    return null;
  }
});

final adminDashboardProvider = FutureProvider.autoDispose<AdminDashboard>((
  ref,
) async {
  final api = ref.watch(adminApiProvider);
  return api.dashboard();
});

final adminUsersProvider = FutureProvider.autoDispose<AdminList<AdminUser>>((
  ref,
) async {
  final api = ref.watch(adminApiProvider);
  return api.listUsers();
});

final adminOrganizationsProvider =
    FutureProvider.autoDispose<AdminList<AdminOrganization>>((ref) async {
      final api = ref.watch(adminApiProvider);
      return api.listOrganizations();
    });

final adminAuditLogProvider =
    FutureProvider.autoDispose<AdminList<AdminAuditEntry>>((ref) async {
      final api = ref.watch(adminApiProvider);
      return api.listAuditLogs();
    });

/// Unresolved incidents, so the count on the card matches what the sheet lists.
final adminIncidentsProvider =
    FutureProvider.autoDispose<AdminList<AdminIncident>>((ref) async {
      final api = ref.watch(adminApiProvider);
      return api.listIncidents(resolved: false);
    });

final adminReadinessProvider = FutureProvider.autoDispose<AdminReadiness>((
  ref,
) async {
  final api = ref.watch(adminApiProvider);
  return api.readiness();
});

/// The organization whose 30-day usage the console reports.
///
/// The API exposes no "my organization" route and the access token carries no
/// tenant claim, so this defaults to the newest organization in the list and can
/// be switched. Nothing is inferred from the user's own account.
class AdminWorkspaceSelection extends Notifier<String?> {
  @override
  String? build() => null;

  void select(String id) => state = id;
}

final adminWorkspaceProvider =
    NotifierProvider<AdminWorkspaceSelection, String?>(
      AdminWorkspaceSelection.new,
    );

final adminSelectedWorkspaceProvider = Provider.autoDispose<AdminOrganization?>(
  (ref) {
    final orgs =
        ref.watch(adminOrganizationsProvider).asData?.value.items ??
        const <AdminOrganization>[];
    if (orgs.isEmpty) return null;
    final id = ref.watch(adminWorkspaceProvider);
    return orgs.firstWhere((o) => o.id == id, orElse: () => orgs.first);
  },
);

/// `null` when no organization is known — the card then says so instead of
/// showing a zero it did not measure.
final adminUsageSummaryProvider =
    FutureProvider.autoDispose<AdminUsageSummary?>((ref) async {
      final workspace = ref.watch(adminSelectedWorkspaceProvider);
      if (workspace == null) return null;
      return ref.watch(adminApiProvider).usageSummary(workspace.id);
    });

/// Admin writes plus the cache invalidation each one needs.
class AdminMutations {
  AdminMutations(this._ref);

  final Ref _ref;

  Future<void> setUserDisabled(String id, {required bool disabled}) async {
    await _ref.read(adminApiProvider).setUserDisabled(id, disabled: disabled);
    _ref.invalidate(adminUsersProvider);
    _ref.invalidate(adminDashboardProvider);
  }

  Future<void> resolveIncident(String id) async {
    await _ref.read(adminApiProvider).resolveIncident(id);
    _ref.invalidate(adminIncidentsProvider);
    _ref.invalidate(adminDashboardProvider);
  }
}

final adminMutationsProvider = Provider<AdminMutations>(AdminMutations.new);
