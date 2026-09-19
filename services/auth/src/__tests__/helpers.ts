import { AuthContext } from '../middleware.js';

export function createMockCtx(): AuthContext {
 return {
 userId: 'test-user',
 orgId: 'test-org',
 workspaceId: 'test-ws',
 role: 'member',
 permissions: [],
 };
}
