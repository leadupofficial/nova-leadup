/**
 * NOVA Notification Service — Logger
 *
 * Lightweight structured logger using console.
 */

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = typeof LOG_LEVELS[number];

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
 const idx = LOG_LEVELS.indexOf(level);
 const currentIdx = LOG_LEVELS.indexOf(currentLevel);
 return idx >= currentIdx;
}

export const logger = {
 debug: (meta: Record<string, unknown> | string, msg?: string) => {
 if (!shouldLog('debug')) return;
 console.debug(`[notification-service:debug]`, msg || '', meta);
 },
 info: (meta: Record<string, unknown> | string, msg?: string) => {
 if (!shouldLog('info')) return;
 console.info(`[notification-service:info]`, msg || '', typeof meta === 'string' ? '' : meta);
 },
 warn: (meta: Record<string, unknown> | string, msg?: string) => {
 if (!shouldLog('warn')) return;
 console.warn(`[notification-service:warn]`, msg || '', typeof meta === 'string' ? '' : meta);
 },
 error: (meta: Record<string, unknown> | string, msg?: string) => {
 if (!shouldLog('error')) return;
 console.error(`[notification-service:error]`, msg || '', typeof meta === 'string' ? '' : meta);
 },
};
