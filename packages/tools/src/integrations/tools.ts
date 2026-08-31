/**
 * LEA-018 — Integration tools for NOVA tool registry.
 *
 * Exposes calendar integration as callable tools:
 * - connect_calendar: Initiate OAuth2 connection to a calendar provider
 * - list_calendar_events: List events from a connected calendar
 * - create_calendar_event: Create an event in a connected calendar
 */

import type {
 NovaToolDefinition,
 ToolExecutionContext,
 ToolResult,
} from '../tool-registry';
import { ToolRegistry } from '../tool-registry';
import type {
 ConnectCalendarInput,
 ConnectCalendarOutput,
 ListCalendarEventsInput,
 ListCalendarEventsOutput,
 CreateCalendarEventInput,
 CreateCalendarEventOutput,
} from './types';

// ─── Tool Definitions ──────────────────────────────────────────────

const CONNECT_CALENDAR: NovaToolDefinition = {
 name: 'connect_calendar',
 description: 'Connect a calendar provider (Google Calendar or Outlook) via OAuth2. Returns an authorization URL for the user to complete the connection.',
 version: '1.0.0',
 permissionLevel: 2, // External communication — requires approval
 confirmationRequired: true,
 idempotencyRequired: true,
 inputSchema: {
 type: 'object',
 properties: {
 provider: { type: 'string', description: 'Calendar provider: google_calendar or outlook_calendar' },
 redirectUri: { type: 'string', description: 'OAuth redirect URI registered with the provider' },
 state: { type: 'string', description: 'CSRF state token' },
 scopes: { type: 'array', description: 'Optional OAuth scopes' },
 },
 required: ['provider', 'redirectUri', 'state'],
 },
 execute: async (input, ctx): Promise<ToolResult> => {
 const parsed = input as unknown as ConnectCalendarInput;
 const provider = parsed.provider;
 if (provider !== 'google_calendar' && provider !== 'outlook_calendar') {
 return { success: false, error: 'Provider must be google_calendar or outlook_calendar', errorCode: 'VALIDATION_ERROR' };
 }

 // In production, call the IntegrationService to get a real auth URL
 // For now, return a placeholder with the correct structure
 const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=PLACEHOLDER&redirect_uri=${encodeURIComponent(parsed.redirectUri)}&response_type=code&state=${encodeURIComponent(parsed.state)}&access_type=offline&prompt=consent`;

 return {
 success: true,
 data: {
 connectionId: `pending-${ctx.userId}-${Date.now()}`,
 provider,
 status: 'connecting',
 scopes: [],
 message: 'OAuth authorization URL generated. Complete the flow by calling complete_calendar_connection.',
 authUrl,
 state: parsed.state,
 } as ConnectCalendarOutput,
 };
 },
};

const LIST_CALENDAR_EVENTS: NovaToolDefinition = {
 name: 'list_calendar_events',
 description: 'List calendar events from a connected calendar provider within an optional time range.',
 version: '1.0.0',
 permissionLevel: 0, // Read-only
 confirmationRequired: false,
 idempotencyRequired: true,
 inputSchema: {
 type: 'object',
 properties: {
 connectionId: { type: 'string', description: 'ID of the calendar connection to use' },
 timeMin: { type: 'string', description: 'Start of time range (ISO 8601)' },
 timeMax: { type: 'string', description: 'End of time range (ISO 8601)' },
 maxResults: { type: 'number', description: 'Max events to return (default 10)' },
 query: { type: 'string', description: 'Free-text search query' },
 },
 required: ['connectionId'],
 },
 execute: async (input): Promise<ToolResult> => {
 const parsed = input as unknown as ListCalendarEventsInput;
 const maxResults = parsed.maxResults ?? 10;

 // In production, call the IntegrationService.listCalendarEvents()
 // For now, return a structured placeholder
 return {
 success: true,
 data: {
 events: [],
 nextPageToken: undefined,
 total: 0,
 message: `Would fetch up to ${maxResults} events from connection ${parsed.connectionId}${parsed.query ? ` matching "${parsed.query}"` : ''}. Requires IntegrationService wiring.`,
 } as ListCalendarEventsOutput,
 };
 },
};

const CREATE_CALENDAR_EVENT: NovaToolDefinition = {
 name: 'create_calendar_event',
 description: 'Create a new event in a connected calendar provider.',
 version: '1.0.0',
 permissionLevel: 2, // External write — requires approval
 confirmationRequired: true,
 idempotencyRequired: true,
 inputSchema: {
 type: 'object',
 properties: {
 connectionId: { type: 'string', description: 'ID of the calendar connection to use' },
 title: { type: 'string', description: 'Event title' },
 description: { type: 'string', description: 'Event description' },
 location: { type: 'string', description: 'Event location' },
 startTime: { type: 'string', description: 'Event start (ISO 8601)' },
 endTime: { type: 'string', description: 'Event end (ISO 8601)' },
 attendees: { type: 'array', description: 'Attendee email addresses' },
 allDay: { type: 'boolean', description: 'All-day event' },
 timezone: { type: 'string', description: 'Event timezone' },
 sendNotifications: { type: 'boolean', description: 'Send notifications to attendees' },
 },
 required: ['connectionId', 'title', 'startTime', 'endTime'],
 },
 execute: async (input): Promise<ToolResult> => {
 const parsed = input as unknown as CreateCalendarEventInput & { sendNotifications?: boolean };
 if (!parsed.event?.title?.trim()) {
 return { success: false, error: 'Title is required', errorCode: 'VALIDATION_ERROR' };
 }

 const ev = parsed.event;
 return {
 success: true,
 data: {
 event: {
 id: `evt-${Date.now()}`,
 integrationId: parsed.connectionId,
 provider: 'google_calendar',
 externalEventId: `evt-${Date.now()}`,
 title: ev.title,
 description: ev.description,
 location: ev.location,
 startTime: ev.startTime,
 endTime: ev.endTime,
 attendees: ev.attendees,
 allDay: ev.allDay ?? false,
 timezone: ev.timezone,
 status: 'confirmed',
 createdAt: new Date().toISOString(),
 updatedAt: new Date().toISOString(),
 syncedAt: new Date().toISOString(),
 },
 htmlLink: undefined,
 message: 'Event created. Requires IntegrationService wiring for actual calendar API calls.',
 } as CreateCalendarEventOutput,
 };
 },
};

// ─── Registry ──────────────────────────────────────────────────────

const INTEGRATION_TOOL_MAP = new Map<string, NovaToolDefinition>([
 ['connect_calendar', CONNECT_CALENDAR],
 ['list_calendar_events', LIST_CALENDAR_EVENTS],
 ['create_calendar_event', CREATE_CALENDAR_EVENT],
]);

export const IntegrationToolRegistry = {
 get(name: string): NovaToolDefinition | undefined {
 return INTEGRATION_TOOL_MAP.get(name);
 },
 listNames(): readonly string[] {
 return [...INTEGRATION_TOOL_MAP.keys()];
 },
 list(): readonly NovaToolDefinition[] {
 return [...INTEGRATION_TOOL_MAP.values()];
 },
 toClaudeDefinitions() {
 return INTEGRATION_TOOL_MAP.values();
 },
};
