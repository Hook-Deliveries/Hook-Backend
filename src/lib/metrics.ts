import client from 'prom-client';
import type { Request, Response } from 'express';
import { CommerceOutboxEvent } from '@models/commerce/commerce.model';

client.collectDefaultMetrics();

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration by route and status',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

new client.Gauge({
  name: 'outbox_events',
  help: 'Outbox events by status',
  labelNames: ['status'],
  async collect() {
    const rows = await CommerceOutboxEvent.aggregate<{ _id: string; n: number }>([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    this.reset();
    for (const row of rows) this.set({ status: row._id }, row.n);
  },
});

new client.Gauge({
  name: 'outbox_oldest_pending_seconds',
  help: 'Age of the oldest due pending outbox event',
  async collect() {
    const oldest = await CommerceOutboxEvent.findOne({ status: 'pending', availableAt: { $lte: new Date() } })
      .sort({ availableAt: 1 }).select('availableAt').lean();
    this.set(oldest ? (Date.now() - new Date(oldest.availableAt).getTime()) / 1000 : 0);
  },
});

export function recordRequest(req: Request, res: Response, durationMs: number) {
  const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
  httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, durationMs / 1000);
}

export async function metricsHandler(_req: Request, res: Response) {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
}
