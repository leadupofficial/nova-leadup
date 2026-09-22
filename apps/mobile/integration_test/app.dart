import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

import 'auth_flow_test.dart' as auth_flow;
import 'network_resilience_test.dart' as network_resilience;
import 'settings_flow_test.dart' as settings_flow;
import 'voice_flow_test.dart' as voice_flow;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  group('integration', () {
    auth_flow.main();
    voice_flow.main();
    settings_flow.main();
    network_resilience.main();
  });
}
