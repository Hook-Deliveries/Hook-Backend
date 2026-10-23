import { performance } from 'perf_hooks';
import { NextFunction, Request, Response } from 'express';
import { recordRequest } from '@lib/metrics';

const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS || 750);

export function requestTiming(req: Request, res: Response, next: NextFunction) {
  const startedAt = performance.now();
  const originalEnd = res.end.bind(res);

  (res as any).end = (...args: any[]) => {
    const durationMs = performance.now() - startedAt;
    if (!res.headersSent) {
      res.setHeader('Server-Timing', `app;dur=${durationMs.toFixed(1)}`);
    }
    return originalEnd(...args);
  };

  res.once('finish', () => {
    const durationMs = performance.now() - startedAt;
    recordRequest(req, res, durationMs);
    if (req.method === 'POST' && req.route?.path === '/cart/items') {
      console.info(JSON.stringify({ event: 'cart_add_timing', requestId: req.requestId,
        status: res.statusCode, durationMs: Number(durationMs.toFixed(1)) }));
    }
    if (process.env.NODE_ENV !== 'production' && durationMs >= SLOW_REQUEST_MS) {
      console.warn(JSON.stringify({
        event: 'slow_request',
        requestId: req.requestId,
        method: req.method,
        route: req.route?.path || req.path,
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
      }));
    }
  });
  next();
}
