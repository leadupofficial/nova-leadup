-- Seed default feature flags for LEA-57
INSERT INTO feature_flags (key, description, enabled, rollout_percentage, metadata)
VALUES
 ('voice_companion_enabled', 'Enable voice companion experience', true, 100, '{"default": true}'),
 ('stt_whisper_v3', 'Use Whisper V3 for speech-to-text', false, 0, '{"default": false, "experimental": true}'),
 ('tts_streaming', 'Enable streaming TTS responses', false, 50, '{"default": false}'),
 ('tool_use_v2', 'Enable V2 tool use system', false, 0, '{"default": false, "experimental": true}'),
 ('advanced_analytics', 'Show advanced analytics dashboards', true, 100, '{"default": true}'),
 ('beta_features', 'Enable beta feature access', false, 20, '{"default": false}')
ON CONFLICT (key) DO NOTHING;
