/**
 * Shared test data factories for NOVA Leadup E2E tests.
 *
 * All factories use unique identifiers (timestamp-based) so tests
 * running in parallel do not collide. Import and destructure only
 * what you need.
 */

export interface TestUser {
 email: string;
 password: string;
 name: string;
 accessToken?: string;
 refreshToken?: string;
}

export interface TestConversation {
 title: string;
 messages: {
 role: 'user' | 'assistant';
 content: string;
 }[];
}

export interface TestTask {
 title: string;
 description: string;
 priority: 'low' | 'medium' | 'high';
 dueDate: string;
}

/** Create a unique user record for each call. */
export function createTestUser(overrides?: Partial<TestUser>): TestUser {
 const timestamp = Date.now();
 const suffix = Math.random().toString(36).slice(2, 8);
 return {
 email: `e2e-${timestamp}-${suffix}@test.example.com`,
 password: 'TestPassword123!',
 name: `Test User ${suffix}`,
 ...overrides,
 };
}

/** Create a unique conversation payload. */
export function createTestConversation(overrides?: Partial<TestConversation>): TestConversation {
 const suffix = Math.random().toString(36).slice(2, 6);
 return {
 title: `Test Conversation ${suffix}`,
 messages: [
 { role: 'user', content: 'Hello NOVA' },
 { role: 'assistant', content: 'Hello! How can I help you today?' },
 ],
 ...overrides,
 };
}

/** Create a unique task payload. */
export function createTestTask(overrides?: Partial<TestTask>): TestTask {
 const suffix = Math.random().toString(36).slice(2, 6);
 return {
 title: `Test Task ${suffix}`,
 description: 'A test task created by E2E suite',
 priority: 'medium',
 dueDate: '2026-09-15',
 ...overrides,
 };
}

/** Stable text fragments used across spec files. */
export const ONBOARDING_TEXT = {
 welcome: 'Your personal AI companion',
 getStarted: 'Get Started',
 novaName: 'NOVA',
 featuresHeading: 'What NOVA can do',
 voiceHeading: 'Choose your voice',
 privacyHeading: 'Privacy settings',
 completeHeading: 'Welcome',
 enterNova: 'Enter NOVA',
} as const;

export const DASHBOARD_TEXT = {
 greetingPattern: /Good (morning|afternoon|evening)/,
 tasksTodayLabel: 'Tasks Today',
 memoriesLabel: 'Memories',
 remindersLabel: 'Reminders',
 chatsLabel: 'Chats',
 suggestedHeading: 'Suggested',
 recentHeading: 'Recent Activity',
} as const;

export const CONVERSE_TEXT = {
 heading: 'Converse',
 emptyHeading: 'How can I help?',
 placeholder: 'Type a message...',
 sendButton: 'Send',
 listeningState: 'Listening...',
} as const;

export const TASKS_TEXT = {
 heading: 'Tasks',
 addTask: 'Add Task',
 newTaskPlaceholder: "What needs to be done?",
 allFilter: 'All',
 activeFilter: 'Active',
 doneFilter: 'Done',
} as const;

export const SETTINGS_TEXT = {
 heading: 'NOVA',
 profileSection: 'Identity',
 voiceSection: 'Voice & Language',
 featuresSection: 'Features',
 memorySection: 'Memory',
 privacySection: 'Privacy',
} as const;
