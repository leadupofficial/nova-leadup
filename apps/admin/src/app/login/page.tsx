/**
 * Admin login — Server Component wrapper for hydration.
 */
import LoginForm from './LoginForm';

export default function LoginPage() {
 return (
 <div
 style={{
 display: 'flex',
 alignItems: 'center',
 justifyContent: 'center',
 minHeight: '100vh',
 background: '#0a0e1a',
 padding: '2rem',
 }}
 >
 <LoginForm />
 </div>
 );
}
