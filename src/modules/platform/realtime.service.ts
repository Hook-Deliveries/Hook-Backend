import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { sharedCache } from '@modules/platform/cache.service';
import { createAdapter } from '@socket.io/redis-adapter';
import { randomUUID } from 'crypto';
import { parseOrigins, jwtSecret } from '@config/env';
import { createBullConnection, redisConfigured, getRedis, redisKey } from '@config/redis';
import { AccountType } from '@lib/constants';
import { isActiveAccount } from '@lib/account-state';
import { AccountSession } from '@models/platform/session.model';
import { User } from '@models/users/user.model';
import { resolveAccessContext } from '@modules/identity';
import { z } from 'zod';
import { HttpError } from '@utils/http';
import {
  adminCategoryManagersCache,
  adminCategoryCache,
  adminReviewCache,
  adminOperationsCache,
  adminStaffCache,
  adminAccessCatalogCache,
  adminCatalogCache,
  adminDashboardCache,
  adminDeliveryCache,
  adminFinancialCache,
  adminOrderStatsCache,
  adminProductStatsCache,
  publicCatalogCache,
} from '@lib/ttl-cache';

export type RealtimeEventType =
  | 'home.updated'
  | 'catalog.updated'
  | 'cart.updated'
  | 'notification.created'
  | 'notification.updated'
  | 'order.updated'
  | 'admin.dashboard.updated'
  | 'admin.operations.updated'
  | 'negotiation.updated' | 'negotiation.messages' | 'negotiation.processing'
  | 'app-release.updated'
  | 'config.updated';

export interface RealtimeEvent {
  data?: unknown;
  type: RealtimeEventType;
  entityType?: 'product' | 'market' | 'category' | 'home' | 'cart' | 'order' | 'notification';
  entityId?: string;
  version?: number;
  scope?: { stateId?: string; hubId?: string };
  occurredAt: string;
}

export interface RealtimeTargets {
  accountId?: string;
  stateId?: string;
  hubId?: string;
  public?: boolean;
  admin?: boolean;
}

type SocketIdentity = {
  accountType?: string;
  kind: 'customer' | 'staff' | 'public';
  accountId?: string;
  stateIds?: string[];
  hubIds?: string[];
  isSuperAdmin?: boolean;
};

interface AccessTokenPayload {
  sub: string;
  sid?: string;
}

function room(prefix: string, value: string) {
  return `${prefix}:${value}`;
}

function tokenFromSocket(socket: Socket) {
  const auth = socket.handshake.auth as Record<string, unknown>;
  const authToken = typeof auth?.accessToken === 'string' ? auth.accessToken : '';
  const header = socket.handshake.headers.authorization;
  const headerToken = typeof header === 'string' && header.startsWith('Bearer ')
    ? header.slice(7)
    : '';
  return authToken || headerToken;
}

async function authenticateSocket(socket: Socket): Promise<SocketIdentity> {
  const accessToken = tokenFromSocket(socket);
  if (accessToken) {
    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(accessToken, jwtSecret()) as AccessTokenPayload;
    } catch {
      throw new Error('Invalid access token');
    }
    if (!payload.sub || !payload.sid) throw new Error('Session required');

    const [session, user] = await Promise.all([
      AccountSession.findById(payload.sid).select('revokedAt expiresAt').lean(),
      User.findById(payload.sub).select('accountType accountStatus role isActive').lean(),
    ]);
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new Error('Session is no longer active');
    }
    if (!user || !isActiveAccount(user)) throw new Error('Account is not active');

    if (user.accountType === AccountType.STAFF) {
      const access = await resolveAccessContext(user._id.toString());
      return {
        kind: 'staff',
        accountId: user._id.toString(),
        stateIds: access.stateIds,
        hubIds: access.hubIds,
        isSuperAdmin: access.roleKeys.includes('SUPER_ADMIN'),
      };
    }
    return { kind: user.accountType === AccountType.CUSTOMER ? 'customer' : 'staff', accountType: user.accountType, accountId: user._id.toString() };
  }

  return { kind: 'public' };
}

const NODE_ID = randomUUID();

class RealtimeService {
  private io?: SocketIOServer;
  private redisClients: Array<{ quit(): Promise<unknown>; disconnect(): void }> = [];

  attach(httpServer: HttpServer) {
    if (this.io) return this.io;
    const origins = parseOrigins();
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: origins.includes('*') ? true : origins,
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });
    this.connectRedis(this.io);

    this.io.use(async (socket, next) => {
      try {
        socket.data.identity = await authenticateSocket(socket);
        next();
      } catch (error) {
        // An invalid credential must never be downgraded to a public identity.
        if (tokenFromSocket(socket)) {
          next(error instanceof Error ? error : new Error('Socket authentication failed'));
          return;
        }
        socket.data.identity = { kind: 'public' } satisfies SocketIdentity;
        next();
      }
    });

    this.io.on('connection', (socket) => {
      const identity = socket.data.identity as SocketIdentity;
      const accessToken = tokenFromSocket(socket);
      if (accessToken) {
        try { socket.data.sessionId = (jwt.decode(accessToken) as AccessTokenPayload | null)?.sid; } catch { /* authenticated above */ }
        if (socket.data.sessionId) socket.join(room('session', String(socket.data.sessionId)));
      }
      socket.join('public');
      if (identity.accountId) {
        socket.join(room('account', identity.accountId));
        if (identity.kind === 'staff') {
          socket.join('admin');
          socket.join(room('staff', identity.accountId));
          if (identity.isSuperAdmin) socket.join('super_admin');
          identity.stateIds?.forEach((id) => socket.join(room('state', id)));
          identity.hubIds?.forEach((id) => socket.join(room('hub', id)));
        }
      }
      socket.emit('realtime.ready', { version: 1, occurredAt: new Date().toISOString() });
      const inputSchema = z.object({ negotiationId: z.string().min(1).max(80), message: z.string().trim().min(1).max(1000).optional(), requestId: z.string().min(8).max(200).optional() }).strict();
      const acknowledge = async (raw: unknown, ack: unknown, execute: (id: string, input: z.infer<typeof inputSchema>, actor: { customerId: string; partnerId?: string }) => Promise<unknown>) => {
        if (typeof ack !== 'function') return;
        try {
          const current = await authenticateSocket(socket);
          const input = inputSchema.parse(raw);
          if (!current.accountId || current.kind === 'public') throw new HttpError(401, 'Sign in to negotiate');
          let actor: { customerId: string; partnerId?: string };
          if (current.kind === 'customer') actor = { customerId: current.accountId };
          else if (current.accountType === AccountType.PARTNER) {
            const { HookPartner } = await import('@models/platform/operations-accounts.model');
            const { Negotiation } = await import('@models/negotiations/negotiation.model');
            const partner = await HookPartner.findOne({ accountId: current.accountId, status: 'active' }).select('_id').lean();
            const owned = partner ? await Negotiation.findOne({ publicId: input.negotiationId, initiatingPartnerId: partner._id.toString() }).select('customerId').lean() : null;
            if (!owned?.customerId || !partner) throw new HttpError(404, 'Negotiation not found');
            actor = { customerId: owned.customerId, partnerId: partner._id.toString() };
          } else throw new HttpError(403, 'Customer or active Partner required');
          const { NegotiationService } = await import('@modules/negotiation');
          await new NegotiationService().detail(actor, input.negotiationId);
          ack({ ok: true, data: await execute(input.negotiationId, input, actor) });
        } catch (error) {
          ack({ ok: false, error: { code: error instanceof HttpError ? error.code : 'VALIDATION_ERROR', message: error instanceof HttpError ? error.message : 'Invalid negotiation request' } });
        }
      };
      socket.on('negotiation.subscribe', (raw, ack) => void acknowledge(raw, ack, async (id, _input, actor) => {
        socket.data.negotiationId = id;
        const { NegotiationService } = await import('@modules/negotiation');
        return new NegotiationService().detail(actor, id);
      }));
      socket.on('negotiation.unsubscribe', () => { delete socket.data.negotiationId; });
      socket.on('negotiation.send', (raw, ack) => void acknowledge(raw, ack, async (id, input, actor) => {
        if (!input.message || !input.requestId) throw new HttpError(400, 'Message and request ID required');
        const now = Date.now();
        if (now - Number(socket.data.lastNegotiationSend || 0) < 500) throw new HttpError(429, 'Please wait before sending again');
        socket.data.lastNegotiationSend = now;
        const { NegotiationCommandService } = await import('@modules/negotiation');
        return new NegotiationCommandService().run(actor, id, input.requestId, { message: input.message });
      }));
    });

    return this.io;
  }

  /** Clears this process's read caches; broadcastInvalidation() propagates that to the other API nodes. */
  private invalidateLocalCaches(type: string) {
    if (type === 'catalog.updated' || type === 'home.updated') {
      sharedCache.noteInvalidated('catalog');
      publicCatalogCache.clear();
      adminCatalogCache.clear();
      adminProductStatsCache.clear();
      adminCategoryCache.clear();
      adminReviewCache.clear();
    }
    if (type.startsWith('admin.') || type === 'order.updated') {
      adminDashboardCache.clear();
      adminFinancialCache.clear();
      adminOrderStatsCache.clear();
    }
    if (type.startsWith('admin.')) {
      adminCategoryManagersCache.clear();
      adminCategoryCache.clear();
      adminReviewCache.clear();
      adminOperationsCache.clear();
      adminStaffCache.clear();
      adminAccessCatalogCache.clear();
      adminDeliveryCache.clear();
    }
  }

  private broadcastInvalidation(type: string) {
    const redis = getRedis();
    if (!redis) return;
    redis.publish(redisKey('cache-invalidate'), JSON.stringify({ node: NODE_ID, type })).catch(() => undefined);
  }

  /** Connects the Socket.IO adapter and the cross-node cache invalidation channel. */
  private connectRedis(io: SocketIOServer) {
    if (!redisConfigured()) return;
    try {
      const pub = createBullConnection();
      const sub = pub.duplicate();
      const invalidations = pub.duplicate();
      for (const client of [pub, sub, invalidations]) client.on('error', () => undefined);
      io.adapter(createAdapter(pub, sub, { key: redisKey('socket.io') }));
      invalidations.subscribe(redisKey('cache-invalidate')).catch(() => undefined);
      invalidations.on('message', (_channel, raw) => {
        try {
          const message = JSON.parse(raw) as { node?: string; type?: string };
          if (message.node !== NODE_ID && message.type) this.invalidateLocalCaches(message.type);
        } catch { /* ignore malformed messages */ }
      });
      this.redisClients = [pub, sub, invalidations];
    } catch (error) {
      console.warn('[realtime] Redis adapter unavailable; events reach this node only', error instanceof Error ? error.message : error);
    }
  }

  /** For processes with no HTTP server (the worker): publishes events to API-node sockets through the Redis adapter. */
  attachEmitterOnly() {
    if (this.io) return this.io;
    this.io = new SocketIOServer();
    this.connectRedis(this.io);
    return this.io;
  }

  emit(event: Omit<RealtimeEvent, 'occurredAt'> & { occurredAt?: string }, targets: RealtimeTargets = {}) {
    const payload: RealtimeEvent = {
      ...event,
      occurredAt: event.occurredAt || new Date().toISOString(),
    };
    this.invalidateLocalCaches(payload.type);
    if (payload.type === 'catalog.updated' || payload.type === 'home.updated') void sharedCache.bumpVersion('catalog');
    this.broadcastInvalidation(payload.type);
    if (!this.io) return;
    const rooms = new Set<string>();
    if (targets.public || event.type === 'home.updated' || event.type === 'catalog.updated') rooms.add('public');
    // The global admin room is reserved for genuinely global invalidations, so a scoped account can't observe other scopes' changes.
    const scopedState = targets.stateId || payload.scope?.stateId;
    const scopedHub = targets.hubId || payload.scope?.hubId;
    if (targets.admin || event.type.startsWith('admin.')) {
      if (!scopedState && !scopedHub) rooms.add('admin');
      else rooms.add('super_admin');
    }
    if (targets.accountId) rooms.add(room('account', targets.accountId));
    if (targets.stateId) rooms.add(room('state', targets.stateId));
    if (targets.hubId) rooms.add(room('hub', targets.hubId));
    if (payload.scope?.stateId) rooms.add(room('state', payload.scope.stateId));
    if (payload.scope?.hubId) rooms.add(room('hub', payload.scope.hubId));
    if (!rooms.size) return;
    this.io.to([...rooms]).emit(payload.type, payload);
  }

  close() {
    // The worker's emitter-only server has no HTTP engine, so close() can throw or reject; swallow both forms.
    try { void Promise.resolve(this.io?.close()).catch(() => undefined); } catch { /* nothing to close */ }
    this.io = undefined;
    for (const client of this.redisClients) client.quit().catch(() => client.disconnect());
    this.redisClients = [];
  }

  disconnectSession(sessionId: string) {
    if (!this.io) return;
    // A room (not a local scan) so the disconnect reaches every API node.
    this.io.in(room('session', sessionId)).disconnectSockets(true);
  }

  revokeSession(sessionId: string, reason: string) {
    if (!this.io) return;
    for (const socket of this.io.sockets.sockets.values()) {
      if (socket.data.sessionId !== sessionId) continue;
      socket.emit('session.revoked', {
        type: 'session.revoked',
        reason,
        occurredAt: new Date().toISOString(),
      });
      socket.disconnect(true);
    }
  }
}

export const realtime = new RealtimeService();

/** Signals that admin-configured customer-facing data changed, so apps refetch it immediately instead of waiting for a refresh. */
export type ConfigScope = 'delivery' | 'logistics' | 'commerce' | 'legal' | 'coupons' | 'banners';
export function publishConfigChanged(scope: ConfigScope) {
  realtime.emit({ type: 'config.updated', entityId: scope, data: { scope } }, { public: true, admin: true });
}

export function publishRealtime(event: Omit<RealtimeEvent, 'occurredAt'> & { occurredAt?: string }, targets?: RealtimeTargets) {
  realtime.emit(event, targets);
}
