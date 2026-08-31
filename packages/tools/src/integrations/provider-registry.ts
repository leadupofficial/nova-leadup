/**
 * @nova/tools/integrations/provider-registry
 *
 * Registry of supported integration providers with OAuth configuration.
 * Each provider defines the endpoints, scopes, and URL templates
 * needed for the OAuth2 PKCE flow.
 */

import type {
 IntegrationProvider,
 IntegrationProviderDefinition,
 OAuthAuthorizeInput,
 OAuthAuthorizeResult,
 OAuthTokenExchangeInput,
 OAuthTokenResult,
 OAuthRefreshInput,
 OAuthRefreshResult,
} from '@nova/shared-types';

// ─── Google Calendar ───────────────────────────────────────────────

export const GOOGLE_CALENDAR: IntegrationProviderDefinition = {
 provider: 'google_calendar',
 displayName: 'Google Calendar',
 description: 'Sync with Google Calendar to create and manage events.',
 scopes: [
 'https://www.googleapis.com/auth/calendar',
 'https://www.googleapis.com/auth/calendar.events',
 ],
 authUrlTemplate:
 'https://accounts.google.com/o/oauth2/v2/auth?client_id={clientId}&redirect_uri={redirectUri}&response_type=code&scope={scopes}&state={state}&access_type=offline&prompt=consent',
 tokenUrl: 'https://oauth2.googleapis.com/token',
 refreshUrl: 'https://oauth2.googleapis.com/token',
 revokeUrl: 'https://oauth2.googleapis.com/revoke',
 tokenEndpointAuthMethod: 'client_secret_post',
};

// ─── Outlook Calendar ─────────────────────────────────────────────

export const OUTLOOK_CALENDAR: IntegrationProviderDefinition = {
 provider: 'outlook_calendar',
 displayName: 'Outlook Calendar',
 description: 'Sync with Microsoft Outlook / 365 calendar.',
 scopes: ['Calendars.ReadWrite', 'User.Read'],
 authUrlTemplate:
 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id={clientId}&redirect_uri={redirectUri}&response_type=code&scope={scopes}&state={state}&access_type=offline&prompt=consent',
 tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
 refreshUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
 tokenEndpointAuthMethod: 'client_secret_post',
};

// ─── Registry ──────────────────────────────────────────────────────

const PROVIDER_MAP = new Map<IntegrationProvider, IntegrationProviderDefinition>([
 ['google_calendar', GOOGLE_CALENDAR],
 ['outlook_calendar', OUTLOOK_CALENDAR],
]);

export function getProviderDefinition(
 provider: IntegrationProvider,
): IntegrationProviderDefinition | undefined {
 return PROVIDER_MAP.get(provider);
}

export function listProviders(): readonly IntegrationProviderDefinition[] {
 return [...PROVIDER_MAP.values()];
}

export function isSupportedProvider(provider: IntegrationProvider): boolean {
 return PROVIDER_MAP.has(provider);
}

// ─── URL Builders ─────────────────────────────────────────────────

export async function buildAuthUrl(
 input: OAuthAuthorizeInput,
 clientId: string,
): Promise<OAuthAuthorizeResult> {
 const definition = PROVIDER_MAP.get(input.provider);
 if (!definition) {
 throw new Error(`Unsupported provider: ${input.provider}`);
 }

 const scopes = Object.freeze([...input.scopes?.length ? input.scopes : definition.scopes]) as readonly string[];
 const codeVerifier = generateCodeVerifier();
 const codeChallenge = await generateCodeChallenge(codeVerifier);

 let authUrl = definition.authUrlTemplate
 .replace('{clientId}', encodeURIComponent(clientId))
 .replace('{redirectUri}', encodeURIComponent(input.redirectUri))
 .replace('{scopes}', encodeURIComponent(scopes.join(' ')))
 .replace('{state}', encodeURIComponent(input.state));

 authUrl += `&code_challenge=${encodeURIComponent(codeChallenge)}`;
 authUrl += `&code_challenge_method=S256`;

 return { authUrl, state: input.state, codeVerifier, scopes };
}

export async function exchangeCodeForToken(
 input: OAuthTokenExchangeInput,
 clientId: string,
 clientSecret: string,
): Promise<OAuthTokenResult> {
 const definition = PROVIDER_MAP.get(input.provider);
 if (!definition) {
 throw new Error(`Unsupported provider: ${input.provider}`);
 }

 const body = new URLSearchParams({
 grant_type: 'authorization_code',
 code: input.code,
 redirect_uri: input.redirectUri,
 client_id: clientId,
 code_verifier: input.codeVerifier,
 });

 if (definition.tokenEndpointAuthMethod === 'client_secret_post') {
 body.set('client_secret', clientSecret);
 }

 const response = await fetch(definition.tokenUrl, {
 method: 'POST',
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
 body,
 });

 if (!response.ok) {
 const error = await response.text();
 throw new Error(`Token exchange failed: ${response.status} — ${error}`);
 }

 const data = await response.json();
 return {
 accessToken: data.access_token,
 refreshToken: data.refresh_token,
 expiresIn: data.expires_in,
 scopes: data.scope ? data.scope.split(' ') : [],
 tokenType: data.token_type ?? 'Bearer',
 };
}

export async function refreshAccessToken(
 input: OAuthRefreshInput,
 clientId: string,
 clientSecret: string,
): Promise<OAuthRefreshResult> {
 const definition = PROVIDER_MAP.get(input.provider);
 if (!definition) {
 throw new Error(`Unsupported provider: ${input.provider}`);
 }

 const body = new URLSearchParams({
 grant_type: 'refresh_token',
 refresh_token: input.refreshToken,
 client_id: clientId,
 });

 if (definition.tokenEndpointAuthMethod === 'client_secret_post') {
 body.set('client_secret', clientSecret);
 }

 if (input.scopes?.length) {
 body.set('scope', input.scopes.join(' '));
 }

 const response = await fetch(definition.refreshUrl, {
 method: 'POST',
 headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
 body,
 });

 if (!response.ok) {
 const error = await response.text();
 throw new Error(`Token refresh failed: ${response.status} — ${error}`);
 }

 const data = await response.json();
 return {
 accessToken: data.access_token,
 refreshToken: data.refresh_token ?? input.refreshToken,
 expiresIn: data.expires_in,
 scopes: data.scope ? data.scope.split(' ') : [],
 };
}

// ─── PKCE Helpers ─────────────────────────────────────────────────

function generateCodeVerifier(): string {
 const array = new Uint8Array(32);
 crypto.getRandomValues(array);
 return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
 const encoder = new TextEncoder();
 const data = encoder.encode(verifier);
 const hashBuffer = await crypto.subtle.digest('SHA-256', data);
 return base64UrlEncode(new Uint8Array(hashBuffer));
}

function base64UrlEncode(buffer: Uint8Array): string {
 const base64 = btoa(String.fromCharCode(...buffer));
 return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
