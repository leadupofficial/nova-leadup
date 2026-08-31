/**
 * @nova/tools — NOVA tool definitions, registry, and permission levels.
 *
 * This package defines the canonical tool registry and exports types used
 * across the conversation, policy, and api-service layers.
 *
 * Per blueprint Section 10, all tool calls go through:
 * 1. Validation (schema check)
 * 2. Approval gate (if permission level >= 2)
 * 3. Execution
 * 4. Audit logging
 */

import type { PermissionLevel } from '@nova/shared-types';

export type {
	NovaToolDefinition,
	ToolExecutionContext,
	ToolResult,
} from './tool-registry';

export { ToolRegistry } from './tool-registry';

export type { ToolValidationResult } from './validation';

export { validateToolInput } from './validation';

export { PERMISSION_LABELS, PERMISSION_DESCRIPTIONS, requiresConfirmation, ROLE_PERMISSIONS } from './types';

export {
	type CalendarClientOptions,
	CalendarClient,
} from './integrations/calendar-client';

export {
	type OAuthAuthorizeResult,
	type OAuthTokenResult,
	type OAuthRefreshResult,
	type ConnectCalendarOutput,
	type ListCalendarEventsOutput,
	type CreateCalendarEventOutput,
} from '@nova/shared-types';

export {
	GOOGLE_CALENDAR,
	OUTLOOK_CALENDAR,
	getProviderDefinition,
	listProviders,
	isSupportedProvider,
	buildAuthUrl,
	exchangeCodeForToken,
	refreshAccessToken,
} from './integrations/provider-registry';
