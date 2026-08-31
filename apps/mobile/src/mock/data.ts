import React from 'react';

export const mockPersonalityOptions = [
 { id: '1', label: 'Professional', emoji: '💼' },
 { id: '2', label: 'Friendly', emoji: '😊' },
 { id: '3', label: 'Casual', emoji: '😎' },
];

export const mockResponseLengthOptions = [
 { id: '1', label: 'Concise', emoji: '⚡' },
 { id: '2', label: 'Balanced', emoji: '⚖️' },
 { id: '3', label: 'Detailed', emoji: '📚' },
];

export const mockSpeechStyles = [
 { id: '1', label: 'Natural', emoji: '🗣️' },
 { id: '2', label: 'Formal', emoji: '🎩' },
];

export const mockVoiceOptions = [
 { id: '1', name: 'Nova', gender: 'female' },
 { id: '2', name: 'Atlas', gender: 'male' },
];

export const mockAvatarOptions = [
 { id: '1', name: 'Classic', emoji: '🤖' },
 { id: '2', name: 'Modern', emoji: '✨' },
];

export const mockIntegrations = [
 { id: '1', name: 'Google Calendar', icon: '📅', connected: true },
 { id: '2', name: 'Slack', icon: '💬', connected: false },
 { id: '3', name: 'Notion', icon: '📝', connected: false },
];

export const integrationProviders = mockIntegrations;

export const mockRecordingSummaries = [
 { id: '1', title: 'Team Standup', duration: '15:32', date: '2026-08-30', summary: 'Discussed sprint progress and blockers.', actionItems: [{ id: '1', text: 'Update documentation', completed: false }] },
];

export const mockTranscriptSegments = [
 { id: '1', speaker: 'User', text: 'Hey NOVA, what did we discuss?', timestamp: '00:00' },
 { id: '2', speaker: 'NOVA', text: 'You discussed the sprint timeline.', timestamp: '00:05' },
];

export const mockApprovals = [
 { id: '1', toolName: 'send_email', description: 'Send email to team', status: 'pending' as const, timestamp: new Date() },
];
