import type { Metadata, Viewport } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'MC Dash',
  description: 'Manage Minecraft servers with uploaded server packs',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Let the page paint under the notch / home indicator on phones.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-background text-foreground min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
