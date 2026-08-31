'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useAssistantStore } from '../../stores/assistant-store';

export function useWakeWord() {
 const { setState, setWakeWord, wakeWordActive } = useAssistantStore();
 const [isListening, setIsListening] = useState(false);
 const [lastDetected, setLastDetected] = useState<Date | null>(null);
 const countdownRef = useRef<ReturnType<typeof setTimeout>>();

 const startListening = useCallback(() => {
 setIsListening(true);
 }, []);

 const stopListening = useCallback(() => {
 setIsListening(false);
 }, []);

 const simulateDetection = useCallback(() => {
 setState('listening');
 setWakeWord(true);
 setLastDetected(new Date());

 setTimeout(() => {
 setState('idle');
 setWakeWord(false);
 }, 5000);
 }, [setState, setWakeWord]);

 useEffect(() => {
 if (!isListening) return;

 const WAKE_WORDS = ['hey nova', 'hey noVa', 'ok nova'];

 const checkInterval = setInterval(() => {
 const chance = Math.random();
 if (chance < 0.005) {
 simulateDetection();
 }
 }, 1000);

 return () => clearInterval(checkInterval);
 }, [isListening, simulateDetection]);

 return {
 isListening,
 wakeWordActive,
 lastDetected,
 startListening,
 stopListening,
 simulateDetection,
 };
}
