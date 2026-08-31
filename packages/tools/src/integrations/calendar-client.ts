/**
 * LEA-018 — CalendarClient
 *
 * Calendar API client supporting Google Calendar and Outlook.
 * Handles token refresh automatically, normalizes responses to
 * the shared CalendarEvent type.
 *
 * This is a standalone client — it depends on shared-types only,
 * not on the api service layer.
 */

import type {
 IntegrationProvider,
 CalendarEvent,
 CalendarEventInput,
 CalendarEventListOptions,
} from '@nova/shared-types';

export interface CalendarClientOptions {
 readonly clientId: string;
 readonly clientSecret: string;
 readonly accessToken: string;
 readonly refreshToken?: string;
 readonly expiresAt?: number;
 readonly provider: IntegrationProvider;
 readonly onTokenRefreshed?: (result: { accessToken: string; refreshToken?: string; expiresIn: number }) => void;
}

export class CalendarClient {
 private accessToken: string;
 private refreshToken?: string;
 private expiresAt?: number;
 private readonly clientId: string;
 private readonly clientSecret: string;
 private readonly provider: IntegrationProvider;
 private readonly onTokenRefreshed?: (result: { accessToken: string; refreshToken?: string; expiresIn: number }) => void;

 constructor(options: CalendarClientOptions) {
 this.clientId = options.clientId;
 this.clientSecret = options.clientSecret;
 this.accessToken = options.accessToken;
 this.refreshToken = options.refreshToken;
 this.expiresAt = options.expiresAt;
 this.provider = options.provider;
 this.onTokenRefreshed = options.onTokenRefreshed;
 }

 async ensureValidToken(): Promise<string> {
 if (!this.expiresAt || Date.now() >= this.expiresAt) {
 if (!this.refreshToken) {
 throw new Error('Token expired and no refresh token available');
 }
 const refreshed = await this.doRefresh(this.refreshToken);
 this.accessToken = refreshed.accessToken;
 if (refreshed.refreshToken) this.refreshToken = refreshed.refreshToken;
 const now = Math.floor(Date.now() / 1000);
 this.expiresAt = now + refreshed.expiresIn;
 this.onTokenRefreshed?.(refreshed);
 }
 return this.accessToken;
 }

 async listEvents(options: CalendarEventListOptions = {}): Promise<{ events: CalendarEvent[]; nextPageToken?: string }> {
 switch (this.provider) {
 case 'google_calendar':
 return this.listEventsGoogle(options);
 case 'outlook_calendar':
 return this.listEventsOutlook(options);
 default:
 throw new Error(`Unsupported provider: ${this.provider}`);
 }
 }

 async createEvent(event: CalendarEventInput, sendNotifications = true): Promise<CalendarEvent> {
 switch (this.provider) {
 case 'google_calendar':
 return this.createEventGoogle(event, sendNotifications);
 case 'outlook_calendar':
 return this.createEventOutlook(event);
 default:
 throw new Error(`Unsupported provider: ${this.provider}`);
 }
 }

 // ─── Google Calendar ─────────────────────────────────────────────────

 private async listEventsGoogle(options: CalendarEventListOptions): Promise<{ events: CalendarEvent[]; nextPageToken?: string }> {
 const token = await this.ensureValidToken();
 const qs = new URLSearchParams();
 if (options.timeMin) qs.set('timeMin', options.timeMin);
 if (options.timeMax) qs.set('timeMax', options.timeMax);
 if (options.maxResults) qs.set('maxResults', String(options.maxResults));
 if ((options as { query?: string }).query) qs.set('q', (options as { query: string }).query);
 qs.set('singleEvents', String(options.singleEvents ?? true));
 qs.set('orderBy', options.orderBy ?? 'startTime');

 const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${qs}`, {
 headers: { Authorization: `Bearer ${token}` },
 });
 if (!res.ok) throw new Error(`Google Calendar error: ${res.status}`);
 const data = await res.json() as Record<string, unknown>;
 return {
 events: (data.items as Array<Record<string, unknown>>).map((item) => this.normalizeGoogleEvent(item)),
 nextPageToken: data.nextPageToken as string | undefined,
 };
 }

 private async createEventGoogle(event: CalendarEventInput, sendNotifications: boolean): Promise<CalendarEvent> {
 const token = await this.ensureValidToken();
 const payload: Record<string, unknown> = {
 summary: event.title,
 start: event.allDay
 ? { date: this.toDateOnly(event.startTime) }
 : { dateTime: event.startTime, timeZone: event.timezone },
 end: event.allDay
 ? { date: this.toDateOnly(event.endTime) }
 : { dateTime: event.endTime, timeZone: event.timezone },
 sendUpdates: sendNotifications ? 'all' : 'none',
 };
 if (event.description) payload.description = event.description;
 if (event.location) payload.location = event.location;
 if (event.attendees?.length) payload.attendees = event.attendees.map((a) => ({ email: a }));

 const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
 method: 'POST',
 headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
 body: JSON.stringify(payload),
 });
 if (!res.ok) throw new Error(`Google Calendar error: ${res.status}`);
 const data = await res.json() as { id: string; htmlLink?: string };
 return this.normalizeGoogleEvent({ ...event, id: data.id, htmlLink: data.htmlLink } as unknown as Record<string, unknown>);
 }

 // ─── Outlook Calendar ─────────────────────────────────────────────────

 private async listEventsOutlook(options: CalendarEventListOptions): Promise<{ events: CalendarEvent[] }> {
 const token = await this.ensureValidToken();
 const qs = new URLSearchParams();
 if (options.timeMin) qs.set('startDateTime', options.timeMin);
 if (options.timeMax) qs.set('endDateTime', options.timeMax);
 if (options.maxResults) qs.set('$top', String(options.maxResults));

 const res = await fetch(`https://graph.microsoft.com/v1.0/me/events?${qs}`, {
 headers: { Authorization: `Bearer ${token}` },
 });
 if (!res.ok) throw new Error(`Outlook Calendar error: ${res.status}`);
 const data = await res.json() as Record<string, unknown>;
 return { events: (data.value as Array<Record<string, unknown>>).map((item) => this.normalizeOutlookEvent(item)) };
 }

 private async createEventOutlook(event: CalendarEventInput): Promise<CalendarEvent> {
 const token = await this.ensureValidToken();
 const payload: Record<string, unknown> = {
 subject: event.title,
 start: { dateTime: event.startTime, timeZone: event.timezone },
 end: { dateTime: event.endTime, timeZone: event.timezone },
 };
 if (event.description) payload.body = { contentType: 'text', content: event.description };
 if (event.location) payload.location = { displayName: event.location };
 if (event.attendees?.length) {
 payload.attendees = event.attendees.map((email) => ({ emailAddress: { address: email }, type: 'required' }));
 }

 const res = await fetch('https://graph.microsoft.com/v1.0/me/events', {
 method: 'POST',
 headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
 body: JSON.stringify(payload),
 });
 if (!res.ok) throw new Error(`Outlook Calendar error: ${res.status}`);
 const data = await res.json() as { id: string; webLink?: string };
 return this.normalizeOutlookEvent({ ...event, id: data.id, webLink: data.webLink });
 }

 // ─── Token Refresh ──────────────────────────────────────────────────

 private async doRefresh(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresIn: number }> {
 const tokenUrl = this.provider === 'google_calendar'
 ? 'https://oauth2.googleapis.com/token'
 : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

 const body = new URLSearchParams({
 grant_type: 'refresh_token',
 refresh_token: refreshToken,
 client_id: this.clientId,
 client_secret: this.clientSecret,
 });

 const res = await fetch(tokenUrl, {
 method: 'POST',
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
 body,
 });
 if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);
 const data = await res.json() as Record<string, unknown>;
 return {
 accessToken: data.access_token as string,
 refreshToken: data.refresh_token as string | undefined,
 expiresIn: (data.expires_in as number) ?? 3600,
 };
 }

 // ─── Normalization ──────────────────────────────────────────────────

 private normalizeGoogleEvent(raw: Record<string, unknown>): CalendarEvent {
 return {
 id: raw.id as string,
 integrationId: '',
 provider: 'google_calendar',
 externalEventId: raw.id as string,
 title: (raw.summary as string) ?? 'Untitled',
 description: raw.description as string | undefined,
 location: raw.location as string | undefined,
 startTime: this.extractDateTime(raw.start),
 endTime: this.extractDateTime(raw.end),
 attendees: (raw.attendees as Array<{ email: string }> | undefined)?.map((a) => a.email),
 allDay: !!(raw.start as { date?: string } | undefined)?.date,
 timezone: this.extractTimeZone(raw.start),
 htmlLink: raw.htmlLink as string | undefined,
 status: ((raw.status as string) ?? 'confirmed') as CalendarEvent['status'],
 createdAt: new Date().toISOString(),
 updatedAt: new Date().toISOString(),
 syncedAt: new Date().toISOString(),
 };
 }

 private normalizeOutlookEvent(raw: Record<string, unknown>): CalendarEvent {
 const body = raw.body as { content?: string } | undefined;
 return {
 id: raw.id as string,
 integrationId: '',
 provider: 'outlook_calendar',
 externalEventId: raw.id as string,
 title: (raw.subject as string) ?? 'Untitled',
 description: body?.content,
 location: (raw.location as { displayName?: string } | undefined)?.displayName,
 startTime: this.extractDateTime(raw.start),
 endTime: this.extractDateTime(raw.end),
 attendees: (raw.attendees as Array<{ emailAddress: { address: string } }> | undefined)?.map((a) => a.emailAddress.address),
 allDay: false,
 timezone: this.extractTimeZone(raw.start),
 htmlLink: raw.webLink as string | undefined,
 status: ((raw.showAs as string) ?? 'confirmed') as CalendarEvent['status'],
 createdAt: new Date().toISOString(),
 updatedAt: new Date().toISOString(),
 syncedAt: new Date().toISOString(),
 };
 }

 private extractDateTime(value: unknown): string {
 if (!value || typeof value !== 'object') return new Date().toISOString();
 const obj = value as { dateTime?: string; date?: string };
 return obj.dateTime ?? obj.date ?? new Date().toISOString();
 }

 private extractTimeZone(value: unknown): string | undefined {
 if (!value || typeof value !== 'object') return undefined;
 const obj = value as { timeZone?: string };
 return obj.timeZone;
 }

 private toDateOnly(iso: string): string {
 return new Date(iso).toISOString().slice(0, 10);
 }
}
