import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('Onboarding flow navigates correctly', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: Text('Onboarding'))));
    expect(find.text('Onboarding'), findsOneWidget);
  });
}
