'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Memory {
 id: string;
 type: 'preference' | 'fact' | 'event' | 'task' | 'relationship' | 'reminder' | 'person' | 'company' | 'project' | 'decision' | 'conversation';
 content: string;
 context?: string;
 timestamp: Date;
 importance: number; // 1-5
 tags: string[];
 encrypted?: boolean;
}

export type MemoryType = Memory['type'];

export interface UserPreferences {
 voice: {
 selected: string;
 speed: number;
 pitch: number;
 language: string;
 };
 ai: {
 model: string;
 creativity: number;
 responseLength: 'short' | 'medium' | 'long';
 proactiveAssistance: boolean;
 };
 memory: {
 retentionDays: number;
 autoSummarize: boolean;
 autoDelete: boolean;
 };
 notifications: {
 proactiveAssistance: boolean;
 reminders: boolean;
 quietHours: { start: string; end: string };
 };
 privacy: {
 privateMode: boolean;
 shareAnalytics: boolean;
 shareWithThirdParties: boolean;
 };
}

export const defaultPreferences: UserPreferences = {
 voice: {
 selected: 'nova',
 speed: 1.0,
 pitch: 1.0,
 language: 'en-US',
 },
 ai: {
 model: 'claude-opus',
 creativity: 70,
 responseLength: 'medium',
 proactiveAssistance: true,
 },
 memory: {
 retentionDays: 90,
 autoSummarize: true,
 autoDelete: true,
 },
 notifications: {
 proactiveAssistance: true,
 reminders: true,
 quietHours: { start: '22:00', end: '07:00' },
 },
 privacy: {
 privateMode: false,
 shareAnalytics: false,
 shareWithThirdParties: false,
 },
};

interface MemoryStore {
 memories: Memory[];
 preferences: UserPreferences;
 addMemory: (memory: Omit<Memory, 'id' | 'timestamp'>) => Memory;
 removeMemory: (id: string) => void;
 updateMemory: (id: string, updates: Partial<Memory>) => void;
 updatePreferences: (updates: Partial<UserPreferences>) => void;
 clearAllMemories: () => void;
}

export const useMemoryStore = create<MemoryStore>()(
 persist(
 (set, get) => ({
 memories: [],
 preferences: defaultPreferences,

 addMemory: (memoryData) => {
 const memory: Memory = {
 ...memoryData,
 id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
 timestamp: new Date(),
 };
 set((state) => ({
 memories: [...state.memories, memory],
 }));
 return memory;
 },

 removeMemory: (id) =>
 set((state) => ({
 memories: state.memories.filter((m) => m.id !== id),
 })),

 updateMemory: (id, updates) =>
 set((state) => ({
 memories: state.memories.map((m) =>
 m.id === id ? { ...m, ...updates } : m
 ),
 })),

 updatePreferences: (updates) =>
 set((state) => ({
 preferences: { ...state.preferences, ...updates },
 })),

 clearAllMemories: () => set({ memories: [] }),
 }),
 {
 name: 'memory-storage',
 }
 )
);
