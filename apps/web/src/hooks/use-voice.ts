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
 const [interimTranscript, setInterimTranscript] = useState('');
 const [isSupported, setIsSupported] = useState(false);
 const [volume, setVolume] = useState(0);
 const silenceTimerRef = useRef<NodeJS.Timeout | null>(null);
 const recognitionRef = useRef<any>(null);

 useEffect(() => {
 const hasSpeechRecognition = typeof window !== 'undefined' &&
 ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
 setIsSupported(hasSpeechRecognition);
 }, []);

 const startListening = useCallback(() => {
 setState('listening');
 setEmotion('calm');
 setTranscript('');
 setInterimTranscript('');

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
 const results = Array.from(event.results) as Array<any>;
 const text = results.map((result) => result[0].transcript).join('');
 setTranscript(text);

 if (event.results[event.results.length - 1]?.isFinal === false) {
 setInterimTranscript(event.results[event.results.length - 1][0].transcript);
 } else {
 setInterimTranscript('');
 }

 // Simulate volume based on transcript length
 setVolume(Math.min(1, text.length / 50));

 // Reset silence timer
 if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
 silenceTimerRef.current = setTimeout(() => {
 if (text.trim()) {
 options.onTranscript?.(text.trim());
 stopListening();
 }
 }, options.silenceTimeout || 3000);
 };

 recognition.onerror = (event: any) => {
 options.onError?.(new Error(event.error));
 stopListening();
 };

 recognition.start();
 recognitionRef.current = recognition;
 }, [isSupported, options, setState, setEmotion]);

 const stopListening = useCallback(() => {
 setState('idle');
 setEmotion('neutral');
 setVolume(0);
 setInterimTranscript('');
 if (silenceTimerRef.current) {
 clearTimeout(silenceTimerRef.current);
 silenceTimerRef.current = null;
 }
 if (recognitionRef.current) {
 try {
 recognitionRef.current.stop();
 } catch { /* already stopped */ }
 recognitionRef.current = null;
 }
 }, [setState, setEmotion]);

 const startVoiceInput = useCallback(() => {
 startListening();
 }, [startListening]);

 const stopVoiceInput = useCallback(() => {
 stopListening();
 }, [stopListening]);

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
 if (recognitionRef.current) {
 try {
 recognitionRef.current.stop();
 } catch { /* already stopped */ }
 }
 };
 }, []);

 return {
 transcript,
 interimTranscript,
 volume,
 isListening,
 isSupported,
 startListening,
 stopListening,
 startVoiceInput,
 stopVoiceInput,
 toggleListening,
 };
}
