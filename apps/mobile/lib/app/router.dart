import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../core/design/widgets/index.dart';
import '../features/admin/admin_page.dart';
import '../features/auth/auth_controller.dart';
import '../features/auth/login_page.dart';
import '../features/auth/register_page.dart';
import '../features/activity/activity_page.dart';
import '../features/briefing/briefing_page.dart';
import '../features/call_recording/call_recording_page.dart';
import '../features/converse/conversations_page.dart';
import '../features/converse/converse_page.dart';
import '../features/device_control/device_control_page.dart';
import '../features/home/home_page.dart';
import '../features/memory/memory_page.dart';
import '../features/notifications/notification_assistant_page.dart';
import '../features/overlay/translate_page.dart';
import '../features/overlay/wakeword_page.dart';
import '../features/recording/recording_page.dart';
import '../features/recording/summary_page.dart';
import '../features/reminders/reminders_page.dart';
import '../features/onboarding/companion_page.dart';
import '../features/onboarding/consent_page.dart';
import '../features/onboarding/health_page.dart';
import '../features/onboarding/offline_page.dart';
import '../features/onboarding/onboarding_service.dart';
import '../features/onboarding/otp_page.dart';
import '../features/onboarding/profile_page.dart';
import '../features/onboarding/splash_page.dart';
import '../features/onboarding/welcome_page.dart';
import '../features/settings/integrations_page.dart';
import '../features/settings/delete_account_page.dart';
import '../features/settings/me_page.dart';
import '../features/settings/privacy_policy_page.dart';
import '../features/settings/wake_word_settings_page.dart';
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

      // Utility surfaces stay reachable under every gate so the app can always
      // explain its own state: the offline screen when connectivity drops, and
      // the splash while startup work is still running.
      if (location == '/offline' || location == '/splash') {
        return null;
      }

      // Gate 1: authentication comes first. The product requires phone auth to be
      // the very first screen a new user sees, so no onboarding step — and none of
      // the app proper — is reachable until there is a session.
      final onAuthRoute = location == '/login' || location == '/register';
      final onOtpRoute = location == '/onboarding/otp';
      if (!auth.isAuthenticated) {
        return (onAuthRoute || onOtpRoute) ? null : '/login';
      }

      // Gate 2: customization/onboarding runs only once authenticated. The OTP step
      // redirects on to the flow: the session it just established is what unlocks it.
      if (onOtpRoute) {
        return status == OnboardingStatus.complete
            ? '/'
            : onboarding.resumeStep().routeName;
      }
      if (status != OnboardingStatus.complete) {
        return inOnboarding ? null : onboarding.resumeStep().routeName;
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
      // Startup and connectivity surfaces. Reachable under every gate.
      GoRoute(
        path: '/splash',
        name: 'splash',
        builder: (context, state) => const SplashPage(),
      ),
      GoRoute(
        path: '/offline',
        name: 'offline',
        builder: (context, state) => const OfflinePage(),
      ),
      // The OTP step sits between registering and sign-in, so it lives with the
      // auth routes rather than inside the onboarding step machine.
      GoRoute(
        path: '/onboarding/otp',
        name: 'onboarding-otp',
        // The screen is transport-agnostic; the caller supplies the live Firebase
        // transport (or nothing, for the standalone @nova/auth service).
        builder: (context, state) {
          final args = state.extra;
          if (args is OtpPageArgs) {
            return OtpPage(
              phone: args.phone,
              requestCode: args.requestCode,
              verifyCode: args.verifyCode,
              onVerified: args.onVerified,
            );
          }
          return const OtpPage();
        },
      ),
      GoRoute(
        path: '/translate',
        name: 'translate',
        builder: (context, state) =>
            TranslatePage(sourceText: state.uri.queryParameters['text']),
      ),
      GoRoute(
        path: '/wakeword',
        name: 'wakeword',
        builder: (context, state) => const WakeWordPage(),
      ),
      GoRoute(
        path: '/admin',
        name: 'admin',
        builder: (context, state) => const AdminPage(),
      ),
      GoRoute(
        path: '/onboarding/welcome',
        name: 'onboarding-welcome',
        builder: (context, state) => const WelcomePage(),
      ),
      // The permissions step. The path stays `/onboarding/permissions` because
      // OnboardingStep.permissions.routeName is asserted by a test and drives
      // resume-on-relaunch, but the screen rendered here is now the port of
      // `onboarding/consent.html`, which is wired to the real consent API as
      // well as the device permissions. The older PermissionsPage is superseded
      // by it and is no longer reachable from the router.
      GoRoute(
        path: '/onboarding/permissions',
        name: 'onboarding-permissions',
        builder: (context, state) => Consumer(
          builder: (context, ref, _) => ConsentPage(
            onDone: (outcome) async {
              final granted = outcome.entries
                  .where((entry) => entry.value)
                  .map((entry) => entry.key)
                  .toList(growable: false);
              await ref
                  .read(onboardingServiceProvider)
                  .saveGrantedPermissions(granted);
              if (context.mounted) {
                context.go(OnboardingStep.profileSetup.routeName);
              }
            },
          ),
        ),
      ),
      GoRoute(
        path: '/onboarding/profile',
        name: 'onboarding-profile',
        builder: (context, state) => const ProfilePage(),
      ),
      GoRoute(
        path: '/onboarding/companion',
        name: 'onboarding-companion',
        builder: (context, state) => const CompanionPage(),
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

      GoRoute(
        path: '/recordings/:id',
        name: 'recording-summary',
        builder: (context, state) =>
            SummaryPage(recordingId: state.pathParameters['id']!),
      ),

      // ── Authenticated app shell ──────────────────────────────────────────
      StatefulShellRoute.indexedStack(
        builder: (context, state, navigationShell) => NovaShell(
          navigationShell: navigationShell,
          location: state.uri.path,
        ),
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
                path: '/conversations',
                name: 'conversations',
                builder: (context, state) => const ConversationsPage(),
              ),
              GoRoute(
                path: '/converse',
                name: 'converse',
                builder: (context, state) => const ConversePage(),
                routes: [
                  GoRoute(
                    path: ':id',
                    name: 'converse-thread',
                    builder: (context, state) =>
                        ConversePage(conversationId: state.pathParameters['id']),
                  ),
                ],
              ),
            ],
          ),
          StatefulShellBranch(
            routes: [
              GoRoute(
                path: '/tasks',
                name: 'tasks',
                builder: (context, state) => const TasksPage(),
                routes: [
                  GoRoute(
                    path: 'record',
                    name: 'record',
                    builder: (context, state) => const RecordingPage(),
                  ),
                  GoRoute(
                    path: 'activity',
                    name: 'activity',
                    builder: (context, state) => const ActivityPage(),
                  ),
                  GoRoute(
                    path: 'reminders',
                    name: 'reminders',
                    builder: (context, state) => const RemindersPage(),
                  ),
                ],
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
                routes: [
                  GoRoute(
                    path: 'integrations',
                    name: 'integrations',
                    builder: (context, state) => const IntegrationsPage(),
                  ),
                  // Smart Notification Assistant (§5.21). Device-local, so it
                  // lives under Me alongside the other privacy controls.
                  GoRoute(
                    path: 'notifications',
                    name: 'notification-assistant',
                    builder: (context, state) =>
                        const NotificationAssistantPage(),
                  ),
                  // Daily briefing (§9.4). Device-local opt-in, so it sits with
                  // the other Me settings.
                  GoRoute(
                    path: 'briefing',
                    name: 'daily-briefing',
                    builder: (context, state) => const DailyBriefingPage(),
                  ),
                  // Device & system control (§9.2). Device-local, and the place
                  // the Wi-Fi/Bluetooth-by-deep-link limits are disclosed.
                  GoRoute(
                    path: 'device-control',
                    name: 'device-control',
                    builder: (context, state) => const DeviceControlPage(),
                  ),
                  // Call-recording summaries (requirement 6c). Device-local, and
                  // deliberately not "call screening": it reads recordings the
                  // user's own dialer already saved, in a folder they granted
                  // through the Storage Access Framework.
                  GoRoute(
                    path: 'call-recordings',
                    name: 'call-recordings',
                    builder: (context, state) => const CallRecordingPage(),
                  ),
                  // Wake word (requirement 2, §5.16/§13.10). Device-local: the
                  // phrase is enforced by the classifiers installed in the app
                  // bundle, and the screen says so. Sits beside the other Me
                  // companion settings.
                  GoRoute(
                    path: 'wake-word',
                    name: 'wake-word-settings',
                    builder: (context, state) => const WakeWordSettingsPage(),
                  ),
                  // Store-required surfaces, both reachable from Profile:
                  //
                  //  * `privacy-policy` — App Review 5.1.1(i) and Play's User Data
                  //    policy require the policy to be readable *in the app*, not only
                  //    linked from the store listing. Renders the same text as the
                  //    public URL and works offline.
                  //  * `delete-account` — App Review 5.1.1(v) and Play's account
                  //    deletion requirement: an account created in the app must be
                  //    deletable from inside the app. Calls `DELETE /api/v1/account`.
                  GoRoute(
                    path: 'privacy-policy',
                    name: 'privacy-policy',
                    builder: (context, state) => const PrivacyPolicyPage(),
                  ),
                  GoRoute(
                    path: 'delete-account',
                    name: 'delete-account',
                    builder: (context, state) => const DeleteAccountPage(),
                  ),
                ],
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
  // Authentication is the first screen of a fresh install. Onboarding, and with it
  // the whole customization flow, opens up only after the session exists.
  if (!auth.isAuthenticated) {
    return '/login';
  }
  if (onboarding.getStatus() != OnboardingStatus.complete) {
    return onboarding.resumeStep().routeName;
  }
  return '/';
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
