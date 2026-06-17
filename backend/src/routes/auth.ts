import { Router } from 'express';
import { z } from 'zod';
import { authEnabled, checkPassword, clearSessionCookie, isAuthenticated, setSessionCookie } from '../auth';
import { logger } from '../logger';

const router = Router();
const loginSchema = z.object({ password: z.string().min(1) });

router.get('/me', (req, res) => {
  res.json({
    authRequired: authEnabled,
    authenticated: authEnabled ? isAuthenticated(req) : true,
  });
});

router.post('/login', (req, res) => {
  if (!authEnabled) {
    return res.json({ ok: true, authRequired: false });
  }
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Password required' });
  }
  if (!checkPassword(parsed.data.password)) {
    logger.warn({ ip: req.ip }, 'Failed login attempt');
    return res.status(401).json({ error: 'Incorrect password' });
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

export default router;
