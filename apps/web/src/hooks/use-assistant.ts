'use client';

import { useState, useCallback, useRef } from 'react';
import { useAssistantStore } from '../stores/assistant-store';
import { useConversationStore } from '../stores/conversation-store';

const MOCK_RESPONSES = [
 "I understand, Abishek. Let me look into that for you.",
 "Got it! I've made a note of that.",
 "Based on what I know, I'd recommend focusing on the CRM proposal first. Kumar seems ready to move forward.",
 "I've set that up for you. Is there anything else you need?",
 "Here's what I found from your recent conversations: You have 3 pending tasks and a meeting at 3 PM today.",
 "Perfect, I've updated your preferences accordingly.",
];

export function useAssistant() {
 const { state, setState, setEmotion, startListening, stopListening } = useAssistantStore();
 const { addMessage, isStreaming, setStreaming } = useConversationStore();
 const [isProcessing, setIsProcessing] = useState(false);
 const cancelledRef = useRef(false);
 const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

 const sendMessage = useCallback(
 async (content: string) => {
 if (!content.trim() || isProcessing) return;

 cancelledRef.current = false;

 addMessage({ role: 'user', content: content.trim() });
 setStreaming(true);
 setState('thinking');
 setEmotion('neutral');
 setIsProcessing(true);

 const responseDelay = 800 + Math.random() * 1200;

 await new Promise((resolve) => {
 timeoutRef.current = setTimeout(resolve, responseDelay);
 });

 if (cancelledRef.current) return;

 const randomResponse = MOCK_RESPONSES[Math.floor(Math.random() * MOCK_RESPONSES.length)];
 setState('speaking');
 setEmotion('happy');

 const words = randomResponse.split(' ');
 let currentText = '';

 const streamingMsg = addMessage({
 role: 'assistant',
 content: '',
 emotion: 'happy',
 });

 for (let i = 0; i < words.length; i++) {
 if (cancelledRef.current) return;
 await new Promise((r) => setTimeout(r, 50 + Math.random() * 60));
 currentText += (i > 0 ? ' ' : '') + words[i];

 useConversationStore.setState((s) => ({
 messages: s.messages.map((m) =>
 m.id === streamingMsg.id ? { ...m, content: currentText } : m
 ),
 }));
 }

 setStreaming(false);
 setIsProcessing(false);

 setTimeout(() => {
 setState('idle');
 setEmotion('neutral');
 }, 1500);
 },
 [addMessage, setStreaming, setState, setEmotion, isProcessing]
 );

 const cancelProcessing = useCallback(() => {
 cancelledRef.current = true;
 if (timeoutRef.current) clearTimeout(timeoutRef.current);
 setStreaming(false);
 setIsProcessing(false);
 setState('idle');
 setEmotion('neutral');
 }, [setStreaming, setState, setEmotion]);

 const toggleListening = useCallback(() => {
 if (state === 'listening') {
 stopListening();
 } else {
 startListening();
 }
 }, [state, startListening, stopListening]);

 return {
 state,
 isStreaming,
 isProcessing,
 sendMessage,
 cancelProcessing,
 toggleListening,
 };
}
