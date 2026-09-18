import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/design/widgets/index.dart';
import '../features/auth/auth_controller.dart';
import '../features/auth/login_page.dart';
import '../features/auth/register_page.dart';
import '../features/converse/converse_page.dart';
import '../features/home/home_page.dart';
import '../features/memory/memory_page.dart';
import '../features/onboarding/health_page.dart';
import '../features/onboarding/onboarding_service.dart';
import '../features/onboarding/permissions_page.dart';
import '../features/onboarding/profile_page.dart';
import '../features/onboarding/welcome_page.dart';
import '../features/settings/me_page.dart';
import '../features/tasks/tasks_page.dart';
import 'providers.dart';
import 'shell.dart';

/// Application routing and the gate that decides onboarding vs. auth vs. app.
///
/// The authenticated app is a [StatefulShellRoute] with the five destinations the
/// OpenDesign export specifies (Home, Converse, Tasks, Memory, Me) so each tab
/// keeps its own navigation stack and the designed `.bottom-nav` can highlight
/// the active branch.
final routerProvider = Provider<GoRouter>((ref) {
  final onboarding = ref.read(onboardingServiceProvider);

  // go_router needs a Listenable, so Riverpod's auth state is bridged into one. The
  // router instance itself must stay stable across auth changes, otherwise GoRouter
  // would be recreated (and navigation state lost) on every sign-in.
  final refresh = ValueNotifier<int>(0);
  final subscription = ref.listen<AuthState>(
    authStateProvider,
    (_, _) => refresh.value++,
  );
  ref.onDispose(() {
    subscription.close();
    refresh.dispose();
  });

  return GoRouter(
    initialLocation: _entryLocation(onboarding, ref.read(authStateProvider)),
    refreshListenable: refresh,
    debugLogDiagnostics: kDebugMode,
    redirect: (context, state) {
      final auth = ref.read(authStateProvider);
      final status = onboarding.getStatus();
      final location = state.matchedLocation;
      final inOnboarding = location.startsWith('/onboarding');

      // Gate 1: onboarding must be finished first.
      if (status != OnboardingStatus.complete) {
        return inOnboarding ? null : onboarding.resumeStep().routeName;
      }

      // Gate 2: authentication.
      final onAuthRoute = location == '/login' || location == '/register';
      if (inOnboarding) {
        return auth.isAuthenticated ? '/' : '/login';
      }
      if (!auth.isAuthenticated) {
        return onAuthRoute ? null : '/login';
      }
      return onAuthRoute ? '/' : null;
    },
    routes: <RouteBase>[
      GoRoute(
        path: '/login',
        name: 'login',
        builder: (context, state) => const LoginPage(),
      ),
      GoRoute(
        path: '/register',
        name: 'register',
        builder: (context, state) => const RegisterPage(),
      ),
      GoRoute(
        path: '/onboarding/welcome',
        name: 'onboarding-welcome',
        builder: (context, state) => const WelcomePage(),
      ),
      GoRoute(
        path: '/onboarding/permissions',
        name: 'onboarding-permissions',
        builder: (context, state) => const PermissionsPage(),
      ),
      GoRoute(
        path: '/onboarding/profile',
        name: 'onboarding-profile',
        builder: (context, state) => const ProfilePage(),
      ),
      GoRoute(
        path: '/onboarding/health',
        name: 'onboarding-health',
        builder: (context, state) => const HealthPage(),
      ),
      // Legacy/terminal onboarding route: never rendered, always redirected by the
      // gate above. Declared so a deep link or a resumed step cannot 404.
      GoRoute(
        path: '/onboarding/complete',
        name: 'onboarding-complete',
        redirect: (context, state) => '/login',
      ),

      // ── Authenticated app shell ──────────────────────────────────────────
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) =>
            NovaShell(navigationShell: navigationShell),
        branches: [
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/',
                name: 'home',
                builder: (context, state) => const HomePage(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/converse',
                name: 'converse',
                builder: (context, state) => const ConversePage(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/tasks',
                name: 'tasks',
                builder: (context, state) => const TasksPage(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/memory',
                name: 'memory',
                builder: (context, state) => const MemoryPage(),
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/me',
                name: 'me',
                builder: (context, state) => const MePage(),
              ),
            ],
          ),
        ],
      ),
    ],
    errorBuilder: (context, state) =>
        _RouteNotFoundScreen(location: state.uri.toString()),
  );
});

String _entryLocation(OnboardingService onboarding, AuthState auth) {
  if (onboarding.getStatus() != OnboardingStatus.complete) {
    return onboarding.resumeStep().routeName;
  }
  return auth.isAuthenticated ? '/' : '/login';
}

class _RouteNotFoundScreen extends StatelessWidget {
  const _RouteNotFoundScreen({required this.location});

  final String location;

  @override
  Widget build(BuildContext context) {
    final c = context.nova;
    return Scaffold(
      backgroundColor: c.bg,
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(NovaSpace.gutter),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.explore_off_rounded, size: 48, color: c.muted),
              const SizedBox(height: NovaSpace.md),
              Text(
                'No screen matches "$location".',
                textAlign: TextAlign.center,
                style: NovaTheme.sectionHeading(c),
              ),
              const SizedBox(height: NovaSpace.md),
              NovaPrimaryButton(
                label: 'Go home',
                expand: false,
                onPressed: () => context.go('/'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
