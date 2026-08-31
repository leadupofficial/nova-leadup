'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Home() {
 const router = useRouter();

 useEffect(() => {
 const hasCompletedOnboarding = localStorage.getItem('nova-onboarding-complete');
 if (hasCompletedOnboarding) {
 router.push('/dashboard');
 } else {
 router.push('/onboarding');
 }
 }, [router]);

 return (
 <div className="min-h-screen bg-nova-bg flex items-center justify-center">
 <div className="text-center">
 <div className="w-16 h-16 border-4 border-nova-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
 <p className="text-nova-text-secondary">Loading NOVA...</p>
 </div>
 </div>
 );
}
