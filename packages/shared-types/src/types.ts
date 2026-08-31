/**
 * @nova/shared-types — Type definitions
 *
 * Central type definitions for the NOVA monorepo.
 * All domain types are defined here and re-exported via index.ts.
 */

// ─── Domain Types ──────────────────────────────────────────────────────────────

export interface User {
 readonly id: string;
 readonly organizationId: string | null;
 readonly workspaceId: string | null;
 readonly email: string | null;
 readonly phone: string | null;
 readonly emailVerified: boolean;
 readonly phoneVerified: boolean;
 readonly name: string;
 readonly avatarUrl: string | null;
 readonly locale: string;
 readonly timezone: string;
 readonly disabled: boolean;
 readonly lastLoginAt: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
}

export interface Session {
 readonly id: string;
 readonly userId: string;
 readonly refreshTokenHash: string;
 readonly deviceId: string | null;
 readonly ipAddress: string | null;
 readonly userAgent: string | null;
 readonly expiresAt: string;
 readonly revokedAt: string | null;
 readonly createdAt: string;
}

export interface AuthResponse {
 readonly user: User;
 readonly token: string;
 readonly refreshToken: string;
}

export interface ApiEnvelope<T> {
 readonly success: boolean;
 readonly data: T | null;
 readonly error: { code: string; message: string } | null;
 readonly meta?: Record<string, unknown>;
}

export interface CompanionConfig {
 readonly model: string;
 readonly systemPrompt: string;
 readonly maxTokens: number;
 readonly temperature: number;
}

export interface AvatarConfig {
 readonly assetId: string | null;
 readonly emotion: string;
 readonly animationDensity: string;
}

export interface PersonaConfig {
 readonly name: string;
 readonly personality: string;
 readonly voiceSpeed: number;
 readonly voiceTone: string;
 readonly languagePolicy: string;
 readonly wakeWordEnabled: boolean;
}

export interface NotificationPreferences {
 readonly push: boolean;
 readonly email: boolean;
 readonly sms: boolean;
 readonly inApp: boolean;
}

export type NotificationMode = 'push' | 'email' | 'sms' | 'in_app';

export interface ParticipantInfo {
 readonly id: string;
 readonly name: string;
 readonly role: string;
}

export interface AudioRecording {
 readonly id: string;
 readonly userId: string;
 readonly tenantId: string | null;
 readonly title: string;
 readonly durationSeconds: number | null;
 readonly language: string | null;
 readonly participants: Record<string, unknown>[];
 readonly status: string;
 readonly storageKey: string;
 readonly storageChecksum: string | null;
 readonly consentRecorded: boolean;
 readonly completedAt: string | null;
 readonly deletedAt: string | null;
 readonly createdAt: string;
}

export interface RecordingSummary {
 readonly id: string;
 readonly recordingId: string;
 readonly transcriptId: string | null;
 readonly summary: string;
 readonly decisions: string[];
 readonly actionItems: string[];
 readonly extractedContacts: Record<string, unknown>[];
 readonly createdAt: string;
}

export interface ActionItem {
 readonly id: string;
 readonly text: string;
 readonly assignee: string | null;
 readonly dueAt: string | null;
 readonly priority: 'low' | 'medium' | 'high';
 readonly completed: boolean;
}

export interface ExtractedContact {
 readonly id: string;
 readonly name: string;
 readonly phone: string | null;
 readonly email: string | null;
 readonly organization: string | null;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
export type TaskSource = 'manual' | 'ai' | 'recording';

export interface Task {
 readonly id: string;
 readonly userId: string;
 readonly tenantId: string | null;
 readonly title: string;
 readonly description: string | null;
 readonly status: TaskStatus;
 readonly dueAt: string | null;
 readonly completedAt: string | null;
 readonly source: TaskSource;
 readonly tags: string[];
 readonly aiConfidence: number | null;
 readonly createdAt: string;
 readonly updatedAt: string;
}

export interface Reminder {
 readonly id: string;
 readonly userId: string;
 readonly title: string;
 readonly triggerAt: string;
 readonly timezone: string;
 readonly repeatRule: string | null;
 readonly linkedTaskId: string | null;
 readonly notificationModes: NotificationMode[];
 readonly status: string;
 readonly acknowledgedAt: string | null;
 readonly dismissedAt: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
}

export type MemoryCategory = 'fact' | 'preference' | 'event' | 'contact' | 'decision';
export type MemoryVisibility = 'private' | 'shared' | 'team';
export type MemorySourceType = 'conversation' | 'recording' | 'manual' | 'imported';
export type MemoryStatus = 'proposed' | 'approved' | 'rejected' | 'archived' | 'active' | 'corrected';
export type MemorySensitivity = 'normal' | 'sensitive' | 'confidential';

export interface MemoryRecord {
 readonly id: string;
 readonly userId: string;
 readonly tenantId: string | null;
 readonly visibility: MemoryVisibility;
 readonly category: MemoryCategory;
 readonly content: string;
 readonly normalizedFacts: Record<string, unknown>;
 readonly sourceType: MemorySourceType;
 readonly sourceIds: string[];
 readonly confidence: number;
 readonly importance: number;
 readonly sensitivity: MemorySensitivity;
 readonly status: MemoryStatus;
 readonly expiresAt: string | null;
 readonly embeddingId: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
}

export interface MemorySearchRequest {
 readonly query: string;
 readonly category?: MemoryCategory;
 readonly visibility?: MemoryVisibility;
 readonly limit?: number;
 readonly offset?: number;
 readonly minConfidence?: number;
 readonly status?: MemoryStatus;
}

export interface MemorySearchResponse {
 readonly results: MemoryRecord[];
 readonly total: number;
 readonly query: string;
 readonly latencyMs: number;
 readonly limit?: number;
 readonly offset?: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ToolApproval {
 readonly id: string;
 readonly userId: string;
 readonly tenantId: string | null;
 readonly toolId: string;
 readonly toolInput: Record<string, unknown>;
 readonly permissionLevel: number;
 readonly status: ApprovalStatus;
 readonly expiresAt: string;
 readonly decidedAt: string | null;
 readonly createdAt: string;
}

export interface ActivityItem {
 readonly id: string;
 readonly userId: string;
 readonly action: string;
 readonly targetType: string;
 readonly targetId: string;
 readonly metadata: Record<string, unknown>;
 readonly occurredAt: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'pending';

export interface IntegrationConnection {
 readonly id: string;
 readonly userId: string;
 readonly tenantId: string | null;
 readonly integrationId: string;
 readonly status: ConnectionStatus;
 readonly encryptedCredentials: string | null;
 readonly scopes: string[];
 readonly lastUsedAt: string | null;
 readonly disconnectedAt: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
}

export interface TranslateRequest {
 readonly text: string;
 readonly sourceLanguage: string;
 readonly targetLanguage: string;
 readonly tanglishAware?: boolean;
 readonly model?: string;
}

export interface TranslateResponse {
 readonly translatedText: string;
 readonly sourceLanguage: string;
 readonly targetLanguage: string;
 readonly detectedLanguage: string;
 readonly confidence: number;
 readonly tanglishDetected: boolean;
 readonly processingMs: number;
 readonly provider: string;
 readonly timestamp: string;
}

export interface TranslationHistoryEntry {
 readonly id: string;
 readonly userId: string;
 readonly originalText: string;
 readonly translatedText: string;
 readonly sourceLanguage: string;
 readonly targetLanguage: string;
 readonly tanglishDetected: boolean;
 readonly confidence: number;
 readonly provider: string;
 readonly processingMs: number;
 readonly createdAt: string;
}

export interface ShareIntent {
 readonly sourceApp: string;
 readonly text: string;
 readonly contentType: 'text' | 'url';
 readonly timestamp: string;
}

export interface NotificationPolicy {
 readonly maxRetries: number;
 readonly retryDelayMs: number;
 readonly fallbackChannel: NotificationMode;
 readonly quietHoursStart: string;
 readonly quietHoursEnd: string;
 readonly quietHoursTimezone: string;
}

export interface WakeWordConfig {
 readonly enabled: boolean;
 readonly word: string;
 readonly sensitivity: number;
 readonly language: string;
}

// ─── Privacy Types ─────────────────────────────────────────────────────────────

export interface PrivacyPreferences {
 readonly id: string;
 readonly userId: string;
 readonly saveConversations: boolean;
 readonly saveRecordings: boolean;
 readonly saveTranscripts: boolean;
 readonly saveMemories: boolean;
 readonly autoDeleteRecordingsDays: number | null;
 readonly autoDeleteTranscriptsDays: number | null;
 readonly cloudProcessing: boolean;
 readonly localProcessing: boolean;
 readonly updatedAt: string;
}

export interface ConsentRecord {
 readonly id: string;
 readonly userId: string;
 readonly purpose: string;
 readonly granted: boolean;
 readonly method: string;
 readonly ipAddress: string | null;
 readonly userAgent: string | null;
 readonly consentedAt: string;
 readonly revokedAt: string | null;
}

export type DataExportFormat = 'json' | 'csv' | 'pdf';

export interface DataExport {
 readonly id: string;
 readonly userId: string;
 readonly format: DataExportFormat;
 readonly status: 'pending' | 'processing' | 'completed' | 'failed';
 readonly downloadUrl: string | null;
 readonly expiresAt: string | null;
 readonly sizeBytes: number | null;
 readonly itemCount: Record<string, number>;
 readonly requestedAt: string;
 readonly completedAt: string | null;
 readonly errorMessage: string | null;
}

export interface RedactedField {
 readonly field: string;
 readonly originalLength: number;
 readonly redactionRule: string;
}

export interface RetentionPolicy {
 readonly id: string;
 readonly organizationId: string;
 readonly artifactType: string;
 readonly retentionDays: number;
 readonly autoDelete: boolean;
 readonly createdAt: string;
 readonly updatedAt: string;
}

export type DeletionRequestStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface DeletionRequest {
 readonly id: string;
 readonly userId: string;
 readonly status: DeletionRequestStatus;
 readonly reason: string | null;
 readonly scheduledFor: string | null;
 readonly processedAt: string | null;
 readonly redactedTranscripts: boolean;
 readonly redactedMemories: boolean;
 readonly auditTrailId: string | null;
 readonly createdAt: string;
 readonly updatedAt: string;
}

// ─── Integrations ────────────────────────────────────────────────────────────────

export type IntegrationProvider = 'google_calendar' | 'outlook_calendar';

export interface IntegrationProviderDefinition {
 readonly provider: IntegrationProvider;
 readonly displayName: string;
 readonly description: string;
 readonly scopes: readonly string[];
 readonly authUrlTemplate: string;
 readonly tokenUrl: string;
 readonly refreshUrl: string;
 readonly revokeUrl?: string;
 readonly tokenEndpointAuthMethod: 'client_secret_post' | 'client_secret_basic';
}

export interface OAuthAuthorizeInput {
 readonly provider: IntegrationProvider;
 readonly redirectUri: string;
 readonly state: string;
 readonly scopes?: readonly string[];
 readonly accessType?: 'offline' | 'online';
 readonly includeGrantedScopes?: boolean;
}

export interface OAuthAuthorizeResult {
 readonly authUrl: string;
 readonly state: string;
 readonly codeVerifier: string;
 readonly scopes: readonly string[];
}

export interface OAuthTokenExchangeInput {
 readonly provider: IntegrationProvider;
 readonly code: string;
 readonly redirectUri: string;
 readonly codeVerifier: string;
}

export interface OAuthTokenResult {
 readonly accessToken: string;
 readonly refreshToken?: string;
 readonly expiresIn: number;
 readonly scopes: readonly string[];
 readonly tokenType: string;
}

export interface OAuthRefreshInput {
 readonly provider: IntegrationProvider;
 readonly refreshToken: string;
 readonly scopes?: readonly string[];
}

export interface OAuthRefreshResult {
 readonly accessToken: string;
 readonly refreshToken?: string;
 readonly expiresIn: number;
 readonly scopes: readonly string[];
}

export interface CalendarEventInput {
 readonly title: string;
 readonly description?: string;
 readonly location?: string;
 readonly startTime: string;
 readonly endTime: string;
 readonly attendees?: readonly string[];
 readonly allDay?: boolean;
 readonly timezone?: string;
}

export interface CalendarEvent {
 readonly id: string;
 readonly integrationId: string;
 readonly provider: IntegrationProvider;
 readonly externalEventId: string;
 readonly title: string;
 readonly description?: string;
 readonly location?: string;
 readonly startTime: string;
 readonly endTime: string;
 readonly attendees?: readonly string[];
 readonly allDay: boolean;
 readonly timezone?: string;
 readonly htmlLink?: string;
 readonly status: 'confirmed' | 'tentative' | 'cancelled';
 readonly createdAt: string;
 readonly updatedAt: string;
 readonly syncedAt: string;
}

export interface CalendarEventListOptions {
 readonly timeMin?: string;
 readonly timeMax?: string;
 readonly maxResults?: number;
 readonly query?: string;
 readonly singleEvents?: boolean;
 readonly orderBy?: 'startTime' | 'updated';
}

export interface ConnectIntegrationInput {
 readonly provider: IntegrationProvider;
 readonly authCode: string;
 readonly state: string;
 readonly redirectUri: string;
 readonly scopes?: readonly string[];
}

export interface DisconnectIntegrationInput {
 readonly connectionId: string;
 readonly reason?: string;
}

export interface ConnectionStatusUpdate {
 readonly connectionId: string;
 readonly status: ConnectionStatus;
 readonly errorCode?: string;
 readonly errorMessage?: string;
}

export interface ConnectCalendarInput {
 readonly provider: 'google_calendar' | 'outlook_calendar';
 readonly authCode: string;
 readonly state: string;
 readonly redirectUri: string;
}

export interface ConnectCalendarOutput {
 readonly connectionId: string;
 readonly provider: IntegrationProvider;
 readonly status: ConnectionStatus;
 readonly scopes: readonly string[];
 readonly message: string;
}

export interface ListCalendarEventsInput {
 readonly connectionId: string;
 readonly timeMin?: string;
 readonly timeMax?: string;
 readonly maxResults?: number;
 readonly query?: string;
}

export interface ListCalendarEventsOutput {
 readonly events: readonly CalendarEvent[];
 readonly nextPageToken?: string;
 readonly total: number;
}

export interface CreateCalendarEventInput {
 readonly connectionId: string;
 readonly event: CalendarEventInput;
 readonly sendNotifications?: boolean;
}

export interface CreateCalendarEventOutput {
 readonly event: CalendarEvent;
 readonly htmlLink?: string;
}

// ─── App Event Types ───────────────────────────────────────────────────────────

export type AppEventType =
 | 'conversation.created'
 | 'conversation.message'
 | 'recording.started'
 | 'recording.completed'
 | 'task.created'
 | 'task.updated'
 | 'task.completed'
 | 'reminder.triggered'
 | 'reminder.acknowledged'
 | 'memory.proposed'
 | 'memory.approved'
 | 'privacy.export_requested'
 | 'privacy.export_completed'
 | 'privacy.deletion_requested'
 | 'privacy.deletion_completed'
 | 'privacy.consent_changed'
 | 'retention.cleanup_completed'
 | 'translation.completed';

export interface AppEvent {
 readonly id: string;
 readonly type: AppEventType;
 readonly userId: string | null;
 readonly tenantId: string | null;
 readonly payload: Record<string, unknown>;
 readonly occurredAt: string;
}

// ─── Request/Response Helpers ──────────────────────────────────────────────────

export interface SummaryRequest {
 readonly recordingId: string;
 readonly includeTranscript: boolean;
 readonly includeActionItems: boolean;
 readonly includeContacts: boolean;
}

export interface SummaryResponse {
 readonly summary: string;
 readonly decisions: string[];
 readonly actionItems: string[];
 readonly extractedContacts: ExtractedContact[];
 readonly language: string;
 readonly confidence: number;
}

export interface MemoryProposeRequest {
 readonly content: string;
 readonly category: MemoryCategory;
 readonly sourceType: MemorySourceType;
 readonly sourceIds?: string[];
 readonly sensitivity?: MemorySensitivity;
}

export interface MemoryApproveRequest {
 readonly approved: boolean;
 readonly importance?: number;
}

export interface LoginRequest {
 readonly email: string;
 readonly password: string;
}

export interface RegisterRequest {
 readonly name: string;
 readonly email: string;
 readonly password: string;
 readonly organizationName?: string;
}

// ─── Observability (LEA-021) ───────────────────────────────────────────────────

export type AuditActorType = 'user' | 'system' | 'agent';
export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditLogEntry {
 readonly id: string;
 readonly userId?: string;
 readonly tenantId?: string;
 readonly requestId?: string;
 readonly sourceDevice?: string;
 readonly actorType: AuditActorType;
 readonly actorId?: string;
 readonly action: string;
 readonly targetType?: string;
 readonly targetId?: string;
 readonly outcome: AuditOutcome;
 readonly details: Record<string, unknown>;
 readonly redactedFields: string[];
 readonly occurredAt: string;
}

export interface UsageSummary {
 readonly metric: string;
 readonly totalValue: number;
 readonly unit: string;
 readonly recordCount: number;
}

export interface UsageByUser {
 readonly userId: string;
 readonly userName?: string;
 readonly userEmail?: string;
 readonly totalValue: number;
 readonly recordCount: number;
}

export interface FeatureFlag {
 readonly id: string;
 readonly key: string;
 readonly enabled: boolean;
 readonly rolloutPercent: number;
 readonly description?: string;
 readonly createdAt: string;
 readonly updatedAt: string;
}

export type IncidentSeverity = 'critical' | 'error' | 'warning' | 'info';

export interface IncidentEvent {
 readonly id: string;
 readonly organizationId?: string;
 readonly severity: IncidentSeverity;
 readonly title: string;
 readonly description?: string;
 readonly resolved: boolean;
 readonly resolvedAt?: string;
 readonly occurredAt: string;
}

export interface HealthCheck {
 readonly name: string;
 readonly status: 'pass' | 'fail' | 'warn';
 readonly message?: string;
 readonly durationMs?: number;
}

export interface HealthStatus {
 readonly status: 'healthy' | 'degraded' | 'unhealthy';
 readonly checks: HealthCheck[];
 readonly timestamp: string;
}

// ─── Recording & Transcription ──────────────────────────────────────────────────

export interface TranscriptSegment {
 readonly speakerIndex: number;
 readonly startMs: number;
 readonly endMs: number;
 readonly text: string;
 readonly confidence: number | null;
 readonly segmentIndex: number;
}

export interface TranscriptionResult {
 readonly recordingId: string;
 readonly fullText: string;
 readonly language: string;
 readonly segments: TranscriptSegment[];
 readonly storageKey: string;
 readonly latencyMs: number;
 readonly withinSla: boolean;
 readonly provider: string;
}

// ─── Avatar Types ─────────────────────────────────────────────────────────────

export type AvatarState =
	| 'idle'
	| 'listening'
	| 'thinking'
	| 'speaking'
	| 'success'
	| 'warning'
	| 'offline'
	| 'recording';

export type Emotion = 'neutral' | 'happy' | 'curious' | 'focused' | 'concerned' | 'excited';

export type Viseme =
	| 'silence'
	| 'PP'
	| 'FF'
	| 'TH'
	| 'DD'
	| 'kk'
	| 'CH'
	| 'SS'
	| 'nn'
	| 'RR'
	| 'aa'
	| 'E'
	| 'ih'
	| 'oh'
	| 'ou';

export type Gesture = 'nod' | 'wave' | 'perk-up' | 'think' | 'celebrate' | 'shake';

export interface AvatarAsset {
 readonly id: string;
 readonly name: string;
 readonly style: 'flat' | 'detailed' | 'minimal';
 readonly primaryColor: string;
 readonly secondaryColor: string;
 readonly backgroundColor: string;
}

export interface AvatarEngine {
 preload(asset: AvatarAsset): Promise<void>;
 setState(state: AvatarState): void;
 setEmotion(emotion: Emotion, intensity: number): void;
 setAudioLevel(level: number): void;
 setViseme?(viseme: Viseme, durationMs: number): void;
 playGesture?(gesture: Gesture): void;
 dispose(): void;
}

// ─── Policy Types ─────────────────────────────────────────────────────────────

export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

export interface PermissionPolicy {
 readonly userId: string;
 readonly tenantId: string | null;
 readonly role: string;
 readonly allowedTools: readonly string[];
 readonly deniedTools: readonly string[];
 readonly maxPermissionLevel: PermissionLevel;
}

export interface ApprovalContext {
 readonly toolId: string;
 readonly toolInput: Record<string, unknown>;
 readonly permissionLevel: PermissionLevel;
 readonly userId: string;
 readonly tenantId: string | null;
 readonly requestId: string;
}

export type PolicyDecision =
	| { readonly allowed: true; readonly requiresConfirmation: boolean }
	| { readonly allowed: false; readonly reason: string };

// ─── Voice Types ──────────────────────────────────────────────────────────────

export type VoiceProvider = 'elevenlabs' | 'sarvam';

export interface VoiceProviderConfig {
 readonly provider: VoiceProvider;
 readonly apiKey: string;
 readonly baseUrl?: string;
 readonly voiceId?: string;
 readonly model?: string;
 readonly language?: string;
}

export interface STTRequest {
 readonly audioBuffer: Buffer;
 readonly contentType: string;
 readonly language: 'en' | 'ta' | 'tanglish';
 readonly sessionId: string;
}

export interface STTResponse {
 readonly transcript: string;
 readonly isFinal: boolean;
 readonly confidence: number;
 readonly language: string;
}

export interface TTSRequest {
 readonly text: string;
 readonly voiceId: string;
 readonly language?: string;
 readonly speed?: number;
 readonly stability?: number;
}

export interface TTSResponse {
 readonly audioBuffer: Buffer;
 readonly contentType: string;
 readonly durationMs: number;
 readonly provider: string;
}

export interface RealtimeVoiceSession {
 readonly sessionId: string;
 readonly provider: VoiceProvider;
 readonly status: 'connecting' | 'active' | 'ended' | 'error';
 readonly startedAt: string;
 readonly endedAt?: string;
}

export interface VoiceSession {
 readonly sessionId: string;
 readonly userId: string;
 readonly provider: VoiceProvider;
 readonly config: VoiceProviderConfig;
 readonly status: 'connecting' | 'active' | 'ended' | 'error';
 readonly transcriptBuffer: STTResponse[];
 readonly audioLevel: number;
 readonly startedAt: Date;
 readonly endedAt?: Date;
}

export interface AudioLevelData {
 readonly level: number;
 readonly peak: number;
 readonly rms: number;
 readonly timestamp: number;
}

// ─── AI Core Extended Types ───────────────────────────────────────────────────

export interface ToolCall {
 readonly id: string;
 readonly name: string;
 readonly input: Record<string, unknown>;
}
