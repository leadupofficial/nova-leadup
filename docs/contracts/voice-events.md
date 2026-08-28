## Voice Processing Events

### VoiceSessionStarted
Published when a user begins a new voice interaction session.

```json
{
 "eventId": "uuid",
 "eventType": "VoiceSessionStarted",
 "timestamp": "2024-01-15T10:30:00Z",
 "source": "api-service",
 "correlationId": "uuid",
 "payload": {
 "sessionId": "uuid",
 "userId": "uuid",
 "tenantId": "uuid",
 "metadata": {
 "source": "web" | "mobile",
 "locale": "en-US"
 }
 }
}
```

### VoiceInputReceived
Published when audio input is received from the user.

```json
{
 "eventId": "uuid",
 "eventType": "VoiceInputReceived",
 "timestamp": "2024-01-15T10:30:05Z",
 "source": "api-service",
 "correlationId": "uuid",
 "payload": {
 "sessionId": "uuid",
 "audioFormat": "wav" | "mp3" | "webm",
 "durationMs": 5000,
 "storagePath": "s3://nova-assets/sessions/{sessionId}/input-{eventId}.webm"
 }
}
```

### VoiceTranscriptionComplete
Published when audio transcription is complete.

```json
{
 "eventId": "uuid",
 "eventType": "VoiceTranscriptionComplete",
 "timestamp": "2024-01-15T10:30:08Z",
 "source": "workers",
 "correlationId": "uuid",
 "payload": {
 "sessionId": "uuid",
 "transcript": "transcribed text",
 "confidence": 0.95,
 "language": "en-US"
 }
}
```

### VoiceResponseGenerated
Published when AI generates a voice response.

```json
{
 "eventId": "uuid",
 "eventType": "VoiceResponseGenerated",
 "timestamp": "2024-01-15T10:30:10Z",
 "source": "api-service",
 "correlationId": "uuid",
 "payload": {
 "sessionId": "uuid",
 "textResponse": "generated response text",
 "audioStoragePath": "s3://nova-assets/sessions/{sessionId}/response-{eventId}.mp3",
 "durationMs": 3000
 }
}
```
