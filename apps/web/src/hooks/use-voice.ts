'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useAssistantStore } from '../stores/assistant-store';

interface UseVoiceOptions {
 onTranscript?: (text: string) => void;
 onError?: (error: Error) => void;
 silenceTimeout?: number;
}

export function useVoice(options: UseVoiceOptions = {}) {
 const { isListening, setState, setEmotion } = useAssistantStore();
 const [transcript, setTranscript] = useState('');
 const [isSupported, setIsSupported] = useState(false);
 const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);

 useEffect(() => {
 const hasSpeechRecognition = typeof window !== 'undefined' &&
 ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
 setIsSupported(hasSpeechRecognition);
 }, []);

 const startListening = useCallback(() => {
 setState('listening');
 setEmotion('calm');
 setTranscript('');

 if (!isSupported) {
 options.onTranscript?.('(Voice not supported - using text input)');
 return;
 }

 // @ts-ignore - Web Speech API
 const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
 if (!SpeechRecognition) return;

 const recognition = new SpeechRecognition();
 recognition.continuous = true;
 recognition.interimResults = true;
 recognition.lang = 'en-US';

 recognition.onresult = (event: any) => {
 const text = Array.from(event.results)
 .map((result) => result[0].transcript)
 .join('');
 setTranscript(text);

 // Reset silence timer
 if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
 silenceTimerRef.current = setTimeout(() => {
 if (text.trim()) {
 options.onTranscript?.(text.trim());
 stopListening();
 }
 }, options.silenceTimeout || 2000);
 };

 recognition.onerror = (event: any) => {
 options.onError?.(new Error(event.error));
 stopListening();
 };

 recognition.start();
 }, [isSupported, options, setState, setEmotion]);

 const stopListening = useCallback(() => {
 setState('idle');
 setEmotion('neutral');
 if (silenceTimerRef.current) {
 clearTimeout(silenceTimerRef.current);
 silenceTimerRef.current = null;
 }
 }, [setState, setEmotion]);

 const toggleListening = useCallback(() => {
 if (isListening) {
 stopListening();
 } else {
 startListening();
 }
 }, [isListening, startListening, stopListening]);

 useEffect(() => {
 return () => {
 if (silenceTimerRef.current) {
 clearTimeout(silenceTimerRef.current);
 }
 };
 }, []);

 return {
 transcript,
 isListening,
 isSupported,
 startListening,
 stopListening,
 toggleListening,
 };
}
