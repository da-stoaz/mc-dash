import pino from 'pino';

export const logger = pino({
  name: 'mc-dash-backend',
  level: process.env.LOG_LEVEL ?? 'info',
});
