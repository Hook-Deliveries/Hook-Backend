import compression from 'compression';
import { redisHealth } from '@config/redis';
import { sharedCache } from '@services/cache.service';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { readFileSync } from 'fs';
import { join } from 'path';
import swaggerUi from 'swagger-ui-express';
import { apiDocsEnabled, parseOrigins } from '@config/env';
import { authLimiter, generalLimiter, sanitizeRequest, uploadLimiter } from '@middleware/security';
import { createAdminRouter } from './routes/admin';
import { createAuthRouter } from './routes/auth';
import { createCustomerRouter } from './routes/customer';
import { createDeviceRouter } from './routes/devices';
import { createPublicRouter } from './routes/public';
import { createUploadRouter } from './routes/upload';
import { createWebhookRouter } from './routes/webhooks';
import { createPartnerRouter, createMarketAssociateRouter } from './routes/platform-self';
import { createPublicGeographyRouter } from './routes/public-geography';
import { createCatalogMediaRouter } from './routes/catalog-media';
import { errorHandler, requestContext, sendError, sendSuccess } from './utils/http';
import { requestTiming } from '@middleware/request-timing';

export function createApp() {
  const app = express();
  const apiPrefix = `/${process.env.API_PREFIX || 'api/v1'}`;
  const swaggerSpecPath = join(process.cwd(), 'swagger-spec.json');
  const swaggerSpec = JSON.parse(readFileSync(swaggerSpecPath, 'utf8'));
  const docsEnabled = apiDocsEnabled();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(requestContext);
  app.use(requestTiming);
  // Smaller responses over slow mobile networks: catalogue payloads compress to a fraction of their size.
  app.use(compression({ threshold: 1024 }));
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  app.use(cors({
    origin: (origin, callback) => {
      const allowed = parseOrigins();
      if (!origin && process.env.NODE_ENV !== 'production') return callback(null, true);
      if (origin && (allowed.includes('*') || allowed.includes(origin))) return callback(null, true);
      return callback(null, false);
    },
    credentials: true,
  }));
  // Paystack signs the exact request bytes. This route must run before the
  // global JSON parser so signature verification cannot be affected by
  // parsing or serialization differences.
  app.post(`${apiPrefix}/webhooks/paystack`, express.raw({ type: 'application/json', limit: '256kb' }), async (req, res, next) => {
    try {
      const { PaymentService } = await import('@services/payment.service');
      const signature = String(req.header('x-paystack-signature') || '');
      sendSuccess(res, await new PaymentService().webhook('paystack', req.body as Buffer, signature, req.requestId));
    } catch (error) { next(error); }
  });
  app.get(`${apiPrefix}/payments/paystack/callback`, (req, res) => {
    const reference = String(req.query.reference || req.query.trxref || '');
    if (!/^[A-Za-z0-9._=-]{1,120}$/.test(reference)) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'A valid payment reference is required',
      );
    }
    const configuredReturnUrl = String(process.env.PAYSTACK_APP_RETURN_URL || '');
    const returnUrl = new URL(
      configuredReturnUrl.startsWith('hook://')
        ? configuredReturnUrl
        : 'hook://payments/return',
    );
    returnUrl.searchParams.set('reference', reference);
    returnUrl.searchParams.set('source', 'paystack');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.redirect(302, returnUrl.toString());
  });
  // Monnify signs clientSecret + the exact request bytes, so this route must also run
  // before the global JSON parser, same reasoning as the Paystack route above.
  app.post(`${apiPrefix}/webhooks/monnify`, express.raw({ type: 'application/json', limit: '256kb' }), async (req, res, next) => {
    try {
      const { PaymentService } = await import('@services/payment.service');
      const signature = String(req.header('monnify-signature') || '');
      sendSuccess(res, await new PaymentService().webhook('monnify', req.body as Buffer, signature, req.requestId));
    } catch (error) { next(error); }
  });
  app.get(`${apiPrefix}/payments/monnify/callback`, (req, res) => {
    const reference = String(req.query.paymentReference || '');
    if (!/^[A-Za-z0-9._=-]{1,120}$/.test(reference)) {
      return sendError(
        res,
        400,
        'VALIDATION_ERROR',
        'A valid payment reference is required',
      );
    }
    const configuredReturnUrl = String(process.env.PAYSTACK_APP_RETURN_URL || '');
    const returnUrl = new URL(
      configuredReturnUrl.startsWith('hook://')
        ? configuredReturnUrl
        : 'hook://payments/return',
    );
    returnUrl.searchParams.set('reference', reference);
    returnUrl.searchParams.set('source', 'monnify');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.redirect(302, returnUrl.toString());
  });
  app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: process.env.FORM_BODY_LIMIT || '1mb' }));
  app.use(sanitizeRequest);
  app.use(generalLimiter);
  if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));
  app.use('/uploads', express.static(join(process.cwd(), 'uploads')));

  app.get('/health', async (_req, res) => {
    // Redis is optional: report it, but a Redis outage is not an API outage.
    sendSuccess(res, { status: 'ok', uptime: process.uptime(), redis: await redisHealth(), cache: sharedCache.stats() });
  });

  app.get('/docs-json', (_req, res) => {
    if (!docsEnabled) {
      sendError(res, 404, 'NOT_FOUND', 'Route not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json(swaggerSpec);
  });

  app.get(['/swagger-spec.json', '/docs/swagger-spec.json'], (_req, res) => {
    if (!docsEnabled) {
      sendError(res, 404, 'NOT_FOUND', 'Route not found');
      return;
    }
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.json(swaggerSpec);
  });

  app.use('/docs', (_req: Request, res: Response, next: NextFunction) => {
    if (!docsEnabled) {
      sendError(res, 404, 'NOT_FOUND', 'Route not found');
      return;
    }
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
      ].join('; '),
    );
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    next();
  }, swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    customSiteTitle: 'Hook API Documentation',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'list',
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 2,
      displayRequestDuration: true,
      filter: true,
    },
  }));

  app.use(`${apiPrefix}/auth`, authLimiter, createAuthRouter());
  app.use(`${apiPrefix}/devices`, createDeviceRouter());
  app.use(`${apiPrefix}/admin`, createAdminRouter());
  app.use(`${apiPrefix}/market-associate`, createMarketAssociateRouter());
  app.use(`${apiPrefix}/partner`, createPartnerRouter());
  app.use(`${apiPrefix}/catalog/media`, uploadLimiter, createCatalogMediaRouter());
  // Public reads are revalidated on every request (cheap 304s via ETag), so an admin change reaches the app the moment
  // the realtime refresh fires instead of waiting out a stale copy.
  app.use(`${apiPrefix}/public`, (req: Request, res: Response, next: NextFunction) => {
    if (req.method === 'GET' && /^\/(categories|markets|banners|operating-states)(\/|$|\?)/.test(req.url)) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    }
    next();
  });
  app.use(`${apiPrefix}/public`, createPublicGeographyRouter());
  app.use(`${apiPrefix}/upload`, uploadLimiter, createUploadRouter());
  app.use(`${apiPrefix}/webhooks`, createWebhookRouter());
  app.use(apiPrefix, createPublicRouter());
  app.use(`${apiPrefix}/guest-sessions`, (req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
      meta: { requestId: req.requestId, timestamp: new Date().toISOString() },
    });
  });
  app.use(apiPrefix, createCustomerRouter());

  app.use('/admin', (_req, res) => {
    res.redirect('http://localhost:3001/dashboard');
  });

  app.use((_req, res) => {
    res.status(404).json({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
      meta: { requestId: _req.requestId, timestamp: new Date().toISOString() },
    });
  });

  app.use(errorHandler);

  return app;
}
