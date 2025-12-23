import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import serversRouter from './routes/servers';
import { config } from './config';
import { logger } from './logger';
import { routerService } from './services/routerService';

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/servers', serversRouter);

// Simple error handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err?.name === 'ZodError') {
    return res.status(400).json({ error: 'Invalid payload', issues: err.errors });
  }
  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(config.port, () => {
  logger.info(`API listening on port ${config.port}`);
});

routerService.start();
