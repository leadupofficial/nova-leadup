import pino from 'pino';

/**
 * The application logger.
 *
 * This used to be a six-line `console.log` wrapper. Every call site already used
 * pino's `logger.info(obj, 'message')` shape, so the output *looked* structured —
 * but it was text, not JSON. Nothing could aggregate it, alert on it, or parse the
 * per-turn cost and latency records without a regex, which is the main reason the
 * product could not be measured.
 *
 * `redact` is the security half. Call sites log whole provider responses, request
 * contexts and user objects; without redaction a token or password that happens to
 * sit on one of those objects is written to disk in plain text, where it outlives
 * the request and gets shipped to whatever collects logs. The paths below cover the
 * shapes this codebase actually logs, and `remove` would be worse than `censor` here
 * because an absent field is indistinguishable from one that was never set.
 */
const redactedPaths = [
	'token',
	'accessToken',
	'refreshToken',
	'access_token',
	'refresh_token',
	'password',
	'newPassword',
	'currentPassword',
	'apiKey',
	'api_key',
	'secret',
	'authorization',
	'cookie',
	'set-cookie',
	'*.token',
	'*.accessToken',
	'*.refreshToken',
	'*.password',
	'*.apiKey',
	'*.api_key',
	'*.secret',
	'*.authorization',
	'*.*.token',
	'*.*.password',
	'*.*.apiKey',
	'req.headers.authorization',
	'req.headers.cookie',
	'headers.authorization',
	'headers.cookie',
	'headers["set-cookie"]',
];

export const logger = pino({
	level: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'development' ? 'debug' : 'info'),
	redact: { paths: redactedPaths, censor: '[redacted]' },
	// The cost and latency records are read by humans during development and by a
	// log pipeline in production; both want the object, not a stringified blob.
	base: { service: 'nova-api' },
	timestamp: pino.stdTimeFunctions.isoTime,
	formatters: {
		// `level` as a word, so a pipeline can filter without knowing pino's numbers.
		level: (label) => ({ level: label }),
	},
});

/** Which redaction paths are active. Exported so a test can assert they are applied. */
export const LOGGER_REDACTED_PATHS = redactedPaths;
