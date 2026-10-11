import { EventEmitter } from 'node:events';
import type { Queryable } from '../db/client.js';

export interface AppEvent {
  type: string;
  at: string;
  [key: string]: unknown;
}

/** In-process bus feeding the SSE stream. */
export class EventBus extends EventEmitter {
  publish(type: string, data: Record<string, unknown> = {}): void {
    const event: AppEvent = { type, at: new Date().toISOString(), ...data };
    this.emit('event', event);
  }
}

/** Appends to an order's timeline (the event table behind the order drawer). */
export async function recordOrderEvent(
  q: Queryable,
  orderId: string,
  at: Date,
  kind: string,
  message: string,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  await q.query('INSERT INTO order_events (order_id, at, kind, message, detail) VALUES ($1, $2, $3, $4, $5)', [
    orderId,
    at.toISOString(),
    kind,
    message,
    detail ? JSON.stringify(detail) : null,
  ]);
}
