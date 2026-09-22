'use client';

import { useState, useCallback, useRef } from 'react';
import { useAssistantStore } from '../stores/assistant-store';
import { useConversationStore } from '../stores/conversation-store';

/**
 * There is exactly one reply, and it is true.
 *
 * This hook does not call the API. It used to pick at random from a list of canned
 * lines that **claimed completed actions** — "I've made a note of that.", "I've set
 * that up for you.", "I've updated your preferences accordingly." — plus a hardcoded
 * briefing naming two real-looking people ("Abishek", "Kumar"). Nothing was recorded,
 * set up or updated, and no such conversation existed. A user reading those replies
 * would reasonably believe the product had done something on their behalf.
 *
 * Fabricated *capability* is the one thing that cannot be left in a surface a user can
 * reach, so the fake delay, the random choice and the word-by-word "streaming" of an
 * invented answer are gone. The honest answer is that this build is not connected.
 *
 * `apps/web` is not the shipped client — the voice companion is `apps/mobile` — so
 * wiring this page to `POST /api/v1/chat` is a decision for whoever owns it. Until
 * then, it says so.
 */
const NOT_CONNECTED_REPLY =
 "This build of the NOVA web preview is not connected to the NOVA API yet, so I can't " +
 "answer or change anything for you here. The voice companion in the mobile app is the " +
 "working client.";

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

 // No fake "thinking" delay: the reply is a fixed notice, and pretending to consider
 // the question is part of what made the fabricated answers convincing.
 await new Promise((resolve) => {
 timeoutRef.current = setTimeout(resolve, 0);
 });

 if (cancelledRef.current) return;

 setState('speaking');
 setEmotion('neutral');

 const words = NOT_CONNECTED_REPLY.split(' ');
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
