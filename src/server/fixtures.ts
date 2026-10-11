import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { templateSpecSchema } from './domain/template.js';
import { FIXTURES_DIR } from './paths.js';

const orderSchema = z.object({
  id: z.string().regex(/^SO-\d{5}$/),
  buyer: z.string().min(1),
  street: z.string().min(1),
  town: z.string().min(1),
  postal: z.string().regex(/^\d{5}$/),
  items: z.array(z.object({ title: z.string(), qty: z.number().int().positive() })).min(1),
  supplier: z.string(),
  placedHoursAgo: z.number(),
  deadlineInHours: z.number(),
});

export const ordersFixtureSchema = z.object({
  seller: z.string(),
  orders: z.array(orderSchema),
  cancelledOnMarketplace: z.array(z.string()),
});

export const suppliersFixtureSchema = z.object({
  suppliers: z.array(z.object({ name: z.string(), senderDomain: z.string(), layout: z.string(), template: templateSpecSchema })),
});

export const fixtureEmailSchema = z.object({
  messageId: z.string(),
  from: z.string().regex(/^[^@\s]+@[a-z0-9.-]+\.example\.com$/, 'sender must be under example.com'),
  fromName: z.string(),
  subject: z.string(),
  contentType: z.enum(['text/plain', 'text/html']),
  body: z.string(),
});
export type FixtureEmail = z.infer<typeof fixtureEmailSchema>;

export const mailboxFixtureSchema = z.object({
  batches: z.array(z.object({ batch: z.number().int().positive(), label: z.string(), emails: z.array(fixtureEmailSchema) })),
});
export type Mailbox = z.infer<typeof mailboxFixtureSchema>;

export const scansFixtureSchema = z.object({
  scans: z.array(z.object({ tracking: z.string(), daysAfterUpload: z.number().int().positive(), status: z.enum(['in_transit', 'delivered']), location: z.string() })),
});

function load<T>(file: string, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')));
}

export interface Fixtures {
  orders: z.infer<typeof ordersFixtureSchema>;
  suppliers: z.infer<typeof suppliersFixtureSchema>;
  mailbox: Mailbox;
  scans: z.infer<typeof scansFixtureSchema>;
}

let cached: Fixtures | undefined;

export function loadFixtures(): Fixtures {
  cached ??= {
    orders: load('orders.json', ordersFixtureSchema),
    suppliers: load('suppliers.json', suppliersFixtureSchema),
    mailbox: load('mailbox.json', mailboxFixtureSchema),
    scans: load('carrier-scans.json', scansFixtureSchema),
  };
  return cached;
}
