import React, { createContext, useContext, ReactNode } from 'react';
import { View, Text, StyleSheet, useColorScheme } from 'react-native';

// Types
export type AvatarState = 'idle' | 'listening' | 'thinking' | 'speaking';
export type Emotion = 'neutral' | 'happy' | 'thinking' | 'excited' | 'calm';
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error';

// Theme interfaces
export interface Theme {
 colors: {
 primary: string;
 secondary: string;
 background: string;
 surface: string;
 text: string;
 textMuted: string;
 accent: string;
 success: string;
 warning: string;
 danger: string;
 };
 spacing: {
 xs: number;
 sm: number;
 md: number;
 lg: number;
 xl: number;
 };
 typography: {
 h1: { fontSize: number; fontWeight: string };
 h2: { fontSize: number; fontWeight: string };
 body: { fontSize: number; fontWeight: string };
 caption: { fontSize: number; fontWeight: string };
 };
}

// Light and dark themes
const lightTheme: Theme = {
 colors: {
 primary: '#6366f1',
 secondary: '#8b5cf6',
 background: '#f8fafc',
 surface: '#ffffff',
 text: '#0b1020',
 textMuted: '#64748b',
 accent: '#22d3ee',
 success: '#10b981',
 warning: '#f59e0b',
 danger: '#ef4444',
 },
 spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
 typography: {
 h1: { fontSize: 32, fontWeight: 'bold' },
 h2: { fontSize: 24, fontWeight: '600' },
 body: { fontSize: 16, fontWeight: '400' },
 caption: { fontSize: 12, fontWeight: '400' },
 },
};

const darkTheme: Theme = {
 colors: {
 primary: '#6366f1',
 secondary: '#8b5cf6',
 background: '#0b1020',
 surface: '#151d33',
 text: '#f8fafc',
 textMuted: '#94a3b8',
 accent: '#22d3ee',
 success: '#10b981',
 warning: '#f59e0b',
 danger: '#ef4444',
 },
 spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
 typography: {
 h1: { fontSize: 32, fontWeight: 'bold' },
 h2: { fontSize: 24, fontWeight: '600' },
 body: { fontSize: 16, fontWeight: '400' },
 caption: { fontSize: 12, fontWeight: '400' },
 },
};

// Context
interface ThemeContextValue {
 theme: Theme;
 isDark: boolean;
 toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

// Provider
export function ThemeProvider({ children }: { children: ReactNode }) {
 const colorScheme = useColorScheme();
 const isDark = colorScheme === 'dark';
 const [darkMode, setDarkMode] = React.useState(isDark);

 const theme = darkMode ? darkTheme : lightTheme;

 const toggleTheme = () => setDarkMode(!darkMode);

 return (
 <ThemeContext.Provider value={{ theme, isDark: darkMode, toggleTheme }}>
 {children}
 </ThemeContext.Provider>
 );
}

// Hook
export function useTheme() {
 const context = useContext(ThemeContext);
 if (!context) {
 throw new Error('useTheme must be used within a ThemeProvider');
 }
 return context;
}

// Additional types used in the app
export interface RecordingSummary {
 id: string;
 title: string;
 duration: string;
 date: string;
 summary: string;
}

export interface ActionItem {
 id: string;
 text: string;
 completed: boolean;
}

export interface ExtractedContact {
 name: string;
 role?: string;
 email?: string;
 phone?: string;
}

export interface ToolApproval {
 id: string;
 toolName: string;
 description: string;
 status: 'pending' | 'approved' | 'denied';
 timestamp: Date;
}

// Utility styles
export const createStyles = (theme: Theme) =>
 StyleSheet.create({
 container: {
 flex: 1,
 backgroundColor: theme.colors.background,
 },
 surface: {
 backgroundColor: theme.colors.surface,
 },
 text: {
 color: theme.colors.text,
 },
 textMuted: {
 color: theme.colors.textMuted,
 },
 primary: {
 color: theme.colors.primary,
 },
});
