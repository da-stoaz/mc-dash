'use client';
// HeroUI provider wrapper for Next.js
import { HeroUIProvider, ToastProvider } from '@heroui/react';
import { AuthGate } from '../components/AuthGate';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <HeroUIProvider>
      <ToastProvider placement="top-right" toastOffset={16} />
      <AuthGate>{children}</AuthGate>
    </HeroUIProvider>
  );
}
