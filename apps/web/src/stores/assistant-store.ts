import { create } from 'zustand';

export type AssistantState =
 | 'idle'
 | 'listening'
 | 'thinking'
 | 'speaking'
 | 'error';

export type Emotion = 'neutral' | 'happy' | 'calm' | 'excited' | 'concerned';

interface AssistantStore {
 state: AssistantState;
 emotion: Emotion;
 isListening: boolean;
 isSpeaking: boolean;
 isThinking: boolean;
 wakeWordActive: boolean;
 setState: (state: AssistantState) => void;
 setEmotion: (emotion: Emotion) => void;
 startListening: () => void;
 stopListening: () => void;
 setSpeaking: (speaking: boolean) => void;
 setThinking: (thinking: boolean) => void;
 setWakeWord: (active: boolean) => void;
 reset: () => void;
}

const initialState = {
 state: 'idle' as AssistantState,
 emotion: 'neutral' as Emotion,
 isListening: false,
 isSpeaking: false,
 isThinking: false,
 wakeWordActive: false,
};

export const useAssistantStore = create<AssistantStore>((set) => ({
 ...initialState,

 setState: (state) => set({
 state,
 isListening: state === 'listening',
 isSpeaking: state === 'speaking',
 isThinking: state === 'thinking',
 }),

 setEmotion: (emotion) => set({ emotion }),

 startListening: () => set({
 state: 'listening',
 isListening: true,
 isSpeaking: false,
 isThinking: false,
 }),

 stopListening: () => set({
 state: 'idle',
 isListening: false,
 }),

 setSpeaking: (speaking) => set({
 state: speaking ? 'speaking' : 'idle',
 isSpeaking: speaking,
 }),

 setThinking: (thinking) => set({
 state: thinking ? 'thinking' : 'idle',
 isThinking: thinking,
 }),

 setWakeWord: (active) => set({ wakeWordActive: active }),

 reset: () => set(initialState),
}));
