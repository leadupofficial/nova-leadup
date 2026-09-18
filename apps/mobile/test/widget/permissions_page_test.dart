import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:nova_mobile/features/onboarding/permissions_page.dart';

void main() {
  testWidgets('PermissionsPage renders all permission tiles and header', (tester) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          home: PermissionsPage(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Permissions'), findsOneWidget);
    expect(find.text('NOVA needs a few permissions'), findsOneWidget);
    expect(find.text('Microphone'), findsOneWidget);
    expect(find.text('Notifications'), findsOneWidget);
    expect(find.text('Alarms & Reminders'), findsOneWidget);
    expect(find.text('Continue'), findsOneWidget);
    expect(find.text('Skip for now'), findsOneWidget);

    // Verify Continue button is disabled when permissions not granted
    final filledButton = tester.widget<FilledButton>(find.byType(FilledButton));
    expect(filledButton.onPressed, isNull);
  });
}
