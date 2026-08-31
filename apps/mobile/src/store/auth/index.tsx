import React, { createContext, useContext, useState, ReactNode } from 'react';

interface User {
 id: string;
 name: string;
 email: string;
}

interface AuthContextValue {
 user: User | null;
 isAuthenticated: boolean;
 login: (email: string, password: string) => Promise<void>;
 logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
 const [user, setUser] = useState<User | null>(null);

 const login = async (email: string, _password: string) => {
 setUser({ id: '1', name: 'Abishek', email });
 };

 const logout = () => setUser(null);

 return (
 <AuthContext.Provider value={{ user, isAuthenticated: !!user, login, logout }}>
 {children}
 </AuthContext.Provider>
 );
}

export function useAuth() {
 const context = useContext(AuthContext);
 if (!context) throw new Error('useAuth must be used within AuthProvider');
 return context;
}
