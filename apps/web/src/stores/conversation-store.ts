import { create } from 'zustand';
import { generateId } from '../../lib/utils';

export interface Message {
 id: string;
 role: 'user' | 'assistant';
 content: string;
 timestamp: Date;
 emotion?: Emotion;
}

export type Emotion = 'neutral' | 'happy' | 'calm' | 'excited' | 'concerned';

interface ConversationStore {
 messages: Message[];
 isStreaming: boolean;
 addMessage: (message: Omit<Message, 'id' | 'timestamp'>) => Message;
 clearMessages: () => void;
 setStreaming: (streaming: boolean) => void;
}

export const useConversationStore = create<ConversationStore>((set, get) => ({
 messages: [],
 isStreaming: false,

 addMessage: (messageData) => {
 const message: Message = {
 ...messageData,
 id: generateId('msg'),
 timestamp: new Date(),
 };
 set((state) => ({
 messages: [...state.messages, message],
 }));
 return message;
 },

 clearMessages: () => set({ messages: [] }),

 setStreaming: (streaming) => set({ isStreaming: streaming }),
}));
