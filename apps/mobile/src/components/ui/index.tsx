import React from 'react';
import { View, Text, TouchableOpacity, TextInput, StyleSheet, Switch } from 'react-native';

// Button
interface ButtonProps {
 title: string;
 onPress: () => void;
 variant?: 'primary' | 'secondary' | 'ghost';
 size?: 'sm' | 'md' | 'lg';
 disabled?: boolean;
}
export function Button({ title, onPress, variant = 'primary', size = 'md', disabled }: ButtonProps) {
 return (
 <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.button, styles[variant], styles[size]]}>
 <Text style={[styles.text, styles[`${variant}Text`]]}>{title}</Text>
 </TouchableOpacity>
 );
}

// Card
interface CardProps { children: React.ReactNode; style?: any; }
export function Card({ children, style }: CardProps) {
 return <View style={[styles.card, style]}>{children}</View>;
}

// SectionHeader
interface SectionHeaderProps { title: string; subtitle?: string; }
export function SectionHeader({ title, subtitle }: SectionHeaderProps) {
 return (
 <View style={styles.sectionHeader}>
 <Text style={styles.sectionTitle}>{title}</Text>
 {subtitle && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
 </View>
 );
}

// EmptyState
interface EmptyStateProps { title: string; message?: string; }
export function EmptyState({ title, message }: EmptyStateProps) {
 return (
 <View style={styles.emptyState}>
 <Text style={styles.emptyTitle}>{title}</Text>
 {message && <Text style={styles.emptyMessage}>{message}</Text>}
 </View>
 );
}

// Badge
interface BadgeProps { label: string; variant?: 'default' | 'success' | 'warning'; }
export function Badge({ label, variant = 'default' }: BadgeProps) {
 return <View style={[styles.badge, styles[`badge_${variant}`]]}><Text style={styles.badgeText}>{label}</Text></View>;
}

// Toggle
interface ToggleProps { value: boolean; onValueChange: (v: boolean) => void; label?: string; }
export function Toggle({ value, onValueChange, label }: ToggleProps) {
 return (
 <View style={styles.toggleRow}>
 {label && <Text style={styles.toggleLabel}>{label}</Text>}
 <Switch value={value} onValueChange={onValueChange} trackColor={{ false: '#767577', true: '#6366f1' }} />
 </View>
 );
}

// Input
interface InputProps { placeholder?: string; value: string; onChangeText: (t: string) => void; }
export function Input({ placeholder, value, onChangeText }: InputProps) {
 return <TextInput style={styles.input} placeholder={placeholder} value={value} onChangeText={onChangeText} />;
}

const styles = StyleSheet.create({
 button: { borderRadius: 12, padding: 12, alignItems: 'center', justifyContent: 'center' },
 primary: { backgroundColor: '#6366f1' },
 secondary: { backgroundColor: '#8b5cf6' },
 ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#6366f1' },
 sm: { padding: 8 },
 md: { padding: 12 },
 lg: { padding: 16 },
 text: { fontWeight: '600' },
 primaryText: { color: '#fff' },
 secondaryText: { color: '#fff' },
 ghostText: { color: '#6366f1' },
 card: { backgroundColor: '#151d33', borderRadius: 16, padding: 16, marginVertical: 8 },
 sectionHeader: { marginVertical: 16 },
 sectionTitle: { fontSize: 20, fontWeight: '700', color: '#f8fafc' },
 sectionSubtitle: { fontSize: 14, color: '#94a3b8', marginTop: 4 },
 emptyState: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48 },
 emptyTitle: { fontSize: 18, fontWeight: '600', color: '#f8fafc', marginBottom: 8 },
 emptyMessage: { fontSize: 14, color: '#94a3b8', textAlign: 'center' },
 badge: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 4, alignSelf: 'flex-start' },
 badge_default: { backgroundColor: 'rgba(99,102,241,0.15)' },
 badge_success: { backgroundColor: 'rgba(16,185,129,0.15)' },
 badge_warning: { backgroundColor: 'rgba(245,158,11,0.15)' },
 badgeText: { fontSize: 12, fontWeight: '600', color: '#6366f1' },
 toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8 },
 toggleLabel: { fontSize: 16, color: '#f8fafc' },
 input: { backgroundColor: '#151d33', borderRadius: 12, padding: 12, color: '#f8fafc', borderWidth: 1, borderColor: 'rgba(99,102,241,0.2)' },
});
