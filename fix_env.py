with open('/Volumes/External/github-projects/NOVA-Leadup/services/auth/src/env.ts', 'r') as f:
 content = f.read()

old = """ if (env.NODE_ENV === 'production') {
 const required = ['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY'] as const;
 for (const key of required) {
 if (!env[key]) {
 console.error(`Missing required env: ${key}`);
 process.exit(1);
 }
 }
 if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
 console.error('JWT_SECRET must be at least 32 characters');
 process.exit(1);
 }
 }"""

new = """ if (env.NODE_ENV === 'production') {
 const required = ['DATABASE_URL', 'JWT_SECRET', 'ANTHROPIC_API_KEY'] as const;
 for (const key of required) {
 if (!env[key]) {
 console.error(`Missing required env: ${key}`);
 process.exit(1);
 }
 }
 if (env.JWT_SECRET && env.JWT_SECRET.length < 32) {
 console.error('JWT_SECRET must be at least 32 characters');
 process.exit(1);
 }
 if (env.AUTH_ENCRYPTION_KEY) {
 try {
 const decoded = Buffer.from(env.AUTH_ENCRYPTION_KEY, 'base64');
 if (decoded.length !== 32) {
 console.error('AUTH_ENCRYPTION_KEY must decode to exactly 32 bytes');
 process.exit(1);
 }
 } catch {
 console.error('AUTH_ENCRYPTION_KEY must be valid base64');
 process.exit(1);
 }
 }
 if (env.API_KEY_SECRET && env.API_KEY_SECRET.length < 32) {
 console.error('API_KEY_SECRET must be at least 32 characters');
 process.exit(1);
 }
 }"""

if old not in content:
 print('OLD TEXT NOT FOUND')
else:
 content = content.replace(old, new, 1)
 with open('/Volumes/External/github-projects/NOVA-Leadup/services/auth/src/env.ts', 'w') as f:
 f.write(content)
 print('DONE')
