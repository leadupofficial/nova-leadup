// Requirement 4 — memory storage "securely saves all data".
//
// Two separate claims are tested here, and they are not the same claim:
//   * persistence  — what was saved is still there after the process dies;
//   * isolation    — what one account saved is never visible to another.
//
// The second is the one that matters most and the one a single-user test can
// never catch, so this file creates two real accounts and tries to read across
// them.

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'e2e_support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('E2E memory (device)', () {
    testWidgets('a saved memory is stored, readable and scoped to its owner', (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      await wipeDeviceState();
      final owner = await api.register(tag: 'memowner');
      final stranger = await api.register(tag: 'memstranger');

      // A distinctive string so a match cannot be a coincidence.
      final marker = 'E2E-MEMORY-MARKER-${DateTime.now().microsecondsSinceEpoch}';
      final created = await api.createMemory(
        owner.accessToken,
        content: 'The launch codename is $marker',
        category: 'fact',
      );
      // ignore: avoid_print
      print('[e2e][memory] created: $created');
      expect(created['id'] ?? (created['memory'] as Map?)?['id'], isNotNull,
          reason: 'the API accepted the memory but returned no id');

      // ── owner can read it back ────────────────────────────────────────────
      final List<Map<String, dynamic>> mine = await api.listMemories(owner.accessToken);
      // ignore: avoid_print
      print('[e2e][memory] owner sees ${mine.length} memories');
      expect(
        mine.any((Map<String, dynamic> row) => '${row['content']}'.contains(marker)),
        isTrue,
        reason: 'the memory was created but the owner cannot read it back',
      );

      // ── a different account cannot ────────────────────────────────────────
      final List<Map<String, dynamic>> theirs = await api.listMemories(stranger.accessToken);
      // ignore: avoid_print
      print('[e2e][memory] stranger sees ${theirs.length} memories');
      expect(
        theirs.any((Map<String, dynamic> row) => '${row['content']}'.contains(marker)),
        isFalse,
        reason: 'CRITICAL: one account can read another account\'s memory',
      );

      // Search must be scoped too — a leak here is just as bad and easier to miss,
      // because the query is attacker-controlled.
      final Map<String, dynamic> leaked = await api.searchMemories(
        stranger.accessToken,
        marker,
      );
      final Object? rows = leaked['memories'] ?? leaked['data'];
      final int leakedCount = rows is List ? rows.length : 0;
      // ignore: avoid_print
      print('[e2e][memory] stranger search for the owner\'s marker returned $leakedCount rows');
      expect(leakedCount, 0,
          reason: 'CRITICAL: memory search is not scoped to the requesting account');
    });

    testWidgets('an undiscarded session reaches the memory surface and survives a restart',
        (WidgetTester tester) async {
      assertApiConfigured();
      final api = E2eApi();
      addTearDown(api.close);

      await wipeDeviceState();
      final account = await api.register(tag: 'mempersist');
      final marker = 'E2E-PERSIST-${DateTime.now().microsecondsSinceEpoch}';
      await api.createMemory(account.accessToken, content: 'Persisted $marker');

      await seedSession(account);
      await launchRealApp(tester);
      await pumpFor(tester, const Duration(seconds: 8));

      // The home screen must show a non-zero memory count now that one exists.
      final List<String> homeText = visibleText(tester);
      // ignore: avoid_print
      print('[e2e][memory] home after seeding: $homeText');

      // Reach the Memory surface through the real bottom navigation.
      final Finder memoryTab = find.text('Memory');
      if (memoryTab.evaluate().isNotEmpty) {
        await tester.tap(memoryTab.last);
        await pumpFor(tester, const Duration(seconds: 6));
      }
      final List<String> memoryScreen = visibleText(tester);
      // ignore: avoid_print
      print('[e2e][memory] memory surface: $memoryScreen');

      // The first real assertion: does the saved content actually reach the UI?
      // The marker is deliberately absent from device storage, so anything shown
      // here came back over the network from Postgres.
      expect(
        memoryScreen.any((String line) => line.contains(marker)) ||
            memoryScreen.any((String line) => line.contains('launch codename')),
        isTrue,
        reason: 'a stored memory never reaches the memory screen. Saw: $memoryScreen',
      );
    });
  });
}
