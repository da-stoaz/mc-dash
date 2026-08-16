import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import serversRouter from './routes/servers';
import authRouter from './routes/auth';
import { assertAuthConfig, requireAuth } from './auth';
import { config } from './config';
import { logger } from './logger';
import { routerService } from './services/routerService';
import { metricsCollector } from './services/metricsCollector';

// Before anything binds a port: refuse to come up unauthenticated by accident.
try {
  assertAuthConfig();
} catch (err) {
  logger.fatal((err as Error).message);
  process.exit(1);
}

const app = express();

// Needed for req.ip behind a reverse proxy / tunnel — the login throttle and the
// failed-login log key off it. See config.trustProxy for when this is safe.
if (config.trustProxy) {
  const hops = Number(config.trustProxy);
  app.set('trust proxy', Number.isFinite(hops) ? hops : config.trustProxy);
}

// Credentialed CORS so the session cookie flows from the frontend origin(s).
app.use(cors({ origin: config.frontendOrigins, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Settings the browser needs but that only the backend's env knows. Served at
// runtime on purpose: the router domain used to be a second, build-time
// NEXT_PUBLIC_ROUTER_DOMAIN in the frontend, so it had to be set twice and the
// bundle rebuilt to change it — and when it was missed the UI silently showed
// bare subdomains instead of full hostnames.
app.get('/config', requireAuth, (_req, res) => {
  res.json({
    routerEnabled: config.routerEnabled,
    routerDomain: config.routerDomain ?? null,
    routerPort: config.routerPort,
  });
});

app.use('/auth', authRouter);
app.use('/servers', requireAuth, serversRouter);

// Simple error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: 'Invalid payload', issues: err.errors });
  }
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(config.port, config.bindHost, () => {
  logger.info(`API listening on ${config.bindHost}:${config.port}`);
});

routerService.start();
metricsCollector.start();
