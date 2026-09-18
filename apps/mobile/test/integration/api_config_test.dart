import 'package:flutter_test/flutter_test.dart';
import 'package:nova_mobile/config/api_config.dart';

void main() {
  group('ApiConfig integration tests', () {
    test('baseUrl returns a valid URL format', () {
      final url = ApiConfig.baseUrl;
      expect(url.startsWith('http://') || url.startsWith('https://'), isTrue);
    });

    test('endpoint getters generate valid paths', () {
      expect(ApiConfig.health, contains('/health'));
      expect(ApiConfig.healthz, contains('/healthz'));
      expect(ApiConfig.authLogin, contains('/api/v1/auth/login'));
      expect(ApiConfig.conversations, contains('/api/v1/conversations'));
      expect(ApiConfig.tasks, contains('/api/v1/tasks'));
      expect(ApiConfig.memories, contains('/api/v1/memories'));
      expect(ApiConfig.notifications, contains('/api/v1/notifications'));
      expect(ApiConfig.voiceWs.startsWith('ws'), isTrue);
    });

    test('Environment enum values are recognized', () {
      expect(Environment.values, contains(Environment.production));
      expect(Environment.values, contains(Environment.staging));
      expect(Environment.values, contains(Environment.development));
    });
  });
}
