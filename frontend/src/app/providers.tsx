'use client';
// HeroUI provider wrapper for Next.js
import { HeroUIProvider, ToastProvider } from '@heroui/react';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <HeroUIProvider>
      <ToastProvider placement="top-right" toastOffset={16} />
      {children}
    </HeroUIProvider>
  );
}
