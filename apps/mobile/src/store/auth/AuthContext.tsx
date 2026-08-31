/**
 * Auth Store — manages user session and authentication state.
 *
 * Uses AsyncStorage for persistence. Makes real API calls to @nova/api
 * for authentication (email/password + OTP).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import {
 login as apiLogin,
 register as apiRegister,
 requestOtp as apiRequestOtp,
 verifyOtp as apiVerifyOtp,
 signOut as apiSignOut,
 getSession as apiGetSession,
 setAccessToken,
 getAccessToken as getStoredToken,
} from '../lib/api-client';
import type { User } from '../types/nova';

interface AuthState {
	user: User | null;
	token: string | null;
	isLoading: boolean;
	isOnboarded: boolean;
	isAuthenticated: boolean;
}

interface AuthContextValue extends AuthState {
	signIn: (email: string, password: string) => Promise<void>;
	signUp: (name: string, email: string, password: string) => Promise<void>;
	signInWithOtp: (phone: string) => Promise<void>;
	verifyOtp: (phone: string, code: string) => Promise<void>;
	signOut: () => Promise<void>;
	completeOnboarding: () => Promise<void>;
	updateUser: (user: User) => Promise<void>;
	refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const STORAGE_KEY = '@nova/auth';
const ONBOARDING_KEY = '@nova/onboarding';

// ─── Provider ────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
	const [state, setState] = useState<AuthState>({
		user: null,
		token: null,
		isLoading: true,
		isOnboarded: false,
		isAuthenticated: false,
	});

	// Restore session on mount
	useEffect(() => {
		const restore = async () => {
			try {
				const raw = await AsyncStorage.getItem(STORAGE_KEY);
				if (raw) {
					const { user, token } = JSON.parse(raw);
					setAccessToken(token);
					setState({ user, token, isLoading: false, isAuthenticated: true, isOnboarded: false });
					// Verify session is still valid
					try {
						const current = await apiGetSession();
						if (current) {
							setState((s) => ({ ...s, user: { ...s.user!, ...current } }));
						} else {
							// Session invalid
							await AsyncStorage.removeItem(STORAGE_KEY);
							setState({ user: null, token: null, isLoading: false, isAuthenticated: false, isOnboarded: false });
						}
					} catch {
						// Network error — keep existing session
					}
				} else {
					setState((s) => ({ ...s, isLoading: false }));
				}
				const onboarding = await AsyncStorage.getItem(ONBOARDING_KEY);
				if (onboarding) {
					setState((s) => ({ ...s, isOnboarded: true }));
				}
			} catch {
				setState((s) => ({ ...s, isLoading: false }));
			}
		};
		restore();
	}, []);

	const persist = async (user: User, token: string) => {
		setAccessToken(token);
		await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token }));
	};

	const signIn = useCallback(async (email: string, password: string) => {
		const result = await apiLogin(email, password);
		await persist(result.user, result.accessToken);
		setState({ user: result.user, token: result.accessToken, isLoading: false, isAuthenticated: true, isOnboarded: false });
	}, []);

	const signUp = useCallback(async (name: string, email: string, password: string) => {
		const result = await apiRegister({ name, email, password });
		await persist(result.user, result.accessToken);
		setState({ user: result.user, token: result.accessToken, isLoading: false, isAuthenticated: true, isOnboarded: false });
	}, []);

	const signInWithOtp = useCallback(async (phone: string) => {
		await apiRequestOtp(phone);
	}, []);

	const verifyOtp = useCallback(async (phone: string, code: string) => {
		const result = await apiVerifyOtp(phone, code);
		const user: User = {
			id: `user-${Date.now()}`,
			name: '',
			email: '',
			emailVerified: false,
			phoneVerified: true,
			avatarUrl: null,
			locale: 'en-IN',
			timezone: 'Asia/Kolkata',
			disabled: false,
			organizationId: null,
			workspaceId: null,
			lastLoginAt: new Date().toISOString(),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await persist(user, result.accessToken);
		setState({ user, token: result.accessToken, isLoading: false, isAuthenticated: true, isOnboarded: false });
	}, []);

	const signOut = useCallback(async () => {
		try {
			await apiSignOut();
		} catch {
			// Ignore sign-out errors
		} finally {
			setAccessToken(null);
			await AsyncStorage.removeItem(STORAGE_KEY);
			setState({ user: null, token: null, isLoading: false, isOnboarded: false, isAuthenticated: false });
		}
	}, []);

	const completeOnboarding = useCallback(async () => {
		await AsyncStorage.setItem(ONBOARDING_KEY, '1');
		setState((s) => ({ ...s, isOnboarded: true }));
	}, []);

	const updateUser = useCallback(async (user: User) => {
		setState((s) => {
			const newState = { ...s, user };
			AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ user, token: s.token })).catch(() => {});
			return newState;
		});
	}, []);

	const refreshSession = useCallback(async () => {
		try {
			const current = await apiGetSession();
			if (current) {
				setState((s) => ({ ...s, user: { ...s.user!, ...current } }));
			}
		} catch {
			// Silently fail — session will be refreshed on next app open
		}
	}, []);

	return (
		<AuthContext.Provider
			value={{
				...state,
				signIn,
				signUp,
				signInWithOtp,
				verifyOtp,
				signOut,
				completeOnboarding,
				updateUser,
				refreshSession,
			}}
		>
			{children}
		</AuthContext.Provider>
	);
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
	const ctx = useContext(AuthContext);
	if (!ctx) throw new Error('useAuth must be used within AuthProvider');
	return ctx;
}
