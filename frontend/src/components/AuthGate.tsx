'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { Button, Card, CardBody, CardHeader, Input } from '@heroui/react';
import { API_BASE, UNAUTHORIZED_EVENT } from '../lib/api';
import { Logo } from './Logo';

type AuthContextValue = {
  authRequired: boolean;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({ authRequired: false, logout: async () => {} });

export const useAuth = () => useContext(AuthContext);

type Status = 'loading' | 'in' | 'out';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [authRequired, setAuthRequired] = useState(false);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async (afterLogin = false) => {
    try {
      const res = await fetch(`${API_BASE}/auth/me`, { credentials: 'include', cache: 'no-store' });
      if (!res.ok) throw new Error('Session check failed');
      const data = await res.json();
      setAuthRequired(Boolean(data.authRequired));
      setStatus(data.authenticated ? 'in' : 'out');
      if (afterLogin && !data.authenticated) {
        setError('Password accepted, but the session could not be established. Check browser cookies and server configuration.');
      }
    } catch {
      setAuthRequired(true);
      setStatus('out');
      setError('Could not reach the server.');
    }
  };

  useEffect(() => {
    check();
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setStatus('out');
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  const logout = async () => {
    try {
      await fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' });
    } catch {
      // ignore; we still drop to the login screen
    }
    setPassword('');
    setStatus('out');
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    // Read the actual field: autofill/password managers can update the DOM
    // without updating React state before the form is submitted.
    const submittedPassword = new FormData(event.currentTarget as HTMLFormElement).get('password');
    if (typeof submittedPassword !== 'string' || !submittedPassword) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: submittedPassword }),
      });
      if (!res.ok) {
        setError(res.status === 401 ? 'Incorrect password' : res.status === 429 ? 'Too many login attempts. Please wait and try again.' : 'Login failed');
        return;
      }
      setPassword('');
      await check(true);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setSubmitting(false);
    }
  };

  if (status === 'loading') {
    return <div className="min-h-screen grid place-items-center text-sm text-white/50">Loading…</div>;
  }

  if (status === 'out') {
    return (
      <div className="min-h-screen grid place-items-center bg-linear-to-b from-slate-950 via-slate-900 to-slate-950 p-4">
        <Card className="w-full max-w-sm bg-white/5 border border-white/10">
          <CardHeader className="flex flex-col items-start gap-1">
            <div className="flex items-center gap-2 text-lg font-semibold">
              <Logo size={20} />
              <span>MC Dash</span>
            </div>
            <div className="text-xs text-white/50">Enter the admin password to continue.</div>
          </CardHeader>
          <CardBody>
            <form onSubmit={submit} className="space-y-3">
              <Input
                type="password"
                name="password"
                autoComplete="current-password"
                required
                label="Password"
                // Server errors must not set customValidity: native validation
                // would block retries before submit can clear the error.
                validationBehavior="aria"
                value={password}
                onValueChange={setPassword}
                autoFocus
                isInvalid={Boolean(error)}
                errorMessage={error ?? undefined}
              />
              <Button color="primary" type="submit" fullWidth isLoading={submitting} isDisabled={submitting}>
                Sign in
              </Button>
            </form>
          </CardBody>
        </Card>
      </div>
    );
  }

  return <AuthContext.Provider value={{ authRequired, logout }}>{children}</AuthContext.Provider>;
}
