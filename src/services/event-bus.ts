import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { OutboxEventType } from '@models/commerce/commerce.model';

export const EVENT_EXCHANGE = 'hook.events';

export const EVENT_DOMAINS = {
  payments: ['PAYMENT_CONFIRMED_EFFECTS'],
  orders: ['ORDER_CREATED_EFFECTS'],
  fulfilment: ['ORDER_APPROVED_FOR_FULFILMENT', 'REFUND_PROCESSED_EFFECTS'],
} satisfies Record<string, OutboxEventType[]>;

export type EventDomain = keyof typeof EVENT_DOMAINS;

let connection: ChannelModel | undefined;
let channel: ConfirmChannel | undefined;
let exitOnClose = false;

export function eventBusEnabled() {
  return Boolean(process.env.EVENT_BUS_URL?.trim());
}

async function getChannel() {
  if (channel) return channel;
  const conn = await amqp.connect(process.env.EVENT_BUS_URL as string);
  conn.on('error', () => undefined);
  conn.on('close', () => {
    connection = undefined;
    channel = undefined;
    if (exitOnClose) {
      console.error('[event-bus] connection closed; exiting so the container restarts');
      process.exit(1);
    }
  });
  const ch = await conn.createConfirmChannel();
  await ch.assertExchange(EVENT_EXCHANGE, 'topic', { durable: true });
  for (const [domain, types] of Object.entries(EVENT_DOMAINS)) {
    const queue = `hook.${domain}`;
    await ch.assertQueue(queue, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
    for (const type of types) await ch.bindQueue(queue, EVENT_EXCHANGE, type);
  }
  connection = conn;
  channel = ch;
  return ch;
}

export async function publishEvent(event: { publicId: string; eventType: string }) {
  const ch = await getChannel();
  ch.publish(EVENT_EXCHANGE, event.eventType, Buffer.from(JSON.stringify(event)), {
    persistent: true,
    messageId: event.publicId,
    contentType: 'application/json',
  });
  await ch.waitForConfirms();
}

export async function consumeDomain(domain: EventDomain, onEvent: (publicId: string) => Promise<unknown>) {
  exitOnClose = true;
  const ch = await getChannel();
  await ch.prefetch(Number(process.env.EVENT_BUS_PREFETCH || 5));
  await ch.consume(`hook.${domain}`, async (message) => {
    if (!message) return;
    try {
      const { publicId } = JSON.parse(message.content.toString()) as { publicId: string };
      await onEvent(publicId);
    } catch (error) {
      console.error(`[event-bus] ${domain} message failed:`, error instanceof Error ? error.message : error);
    } finally {
      ch.ack(message);
    }
  });
}

export async function closeEventBus() {
  exitOnClose = false;
  const conn = connection;
  connection = undefined;
  channel = undefined;
  await conn?.close().catch(() => undefined);
}
