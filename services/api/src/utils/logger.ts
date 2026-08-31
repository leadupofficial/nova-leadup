export const logger = {
 info: (msg: string) => console.log(`[INFO] ${new Date().toISOString()} ${msg}`),
 error: (err: unknown, ctx?: string) => console.error(`[ERROR] ${new Date().toISOString()} ${ctx || ''} ${err instanceof Error ? err.message : String(err)}`),
 debug: (msg: string, data?: object) => process.env.NODE_ENV === 'development' && console.debug(`[DEBUG] ${new Date().toISOString()} ${msg}`, data),
 warn: (msg: string) => console.warn(`[WARN] ${new Date().toISOString()} ${msg}`),
};
