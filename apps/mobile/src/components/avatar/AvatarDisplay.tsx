import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

interface AvatarDisplayProps {
 state?: string;
 size?: number;
}
export function AvatarDisplay({ state = 'idle', size = 120 }: AvatarDisplayProps) {
 const colors: Record<string, string> = {
 idle: '#6366f1',
 listening: '#22d3ee',
 thinking: '#f59e0b',
 speaking: '#10b981',
 };
 return (
 <View style={[styles.container, { width: size, height: size, borderRadius: size / 2, backgroundColor: colors[state] || colors.idle }]}>
 <Text style={styles.emoji}>🎙️</Text>
 </View>
 );
}
const styles = StyleSheet.create({
 container: { alignItems: 'center', justifyContent: 'center' },
 emoji: { fontSize: 40 },
});
