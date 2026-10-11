import type { Fixtures } from '../fixtures.js';
import { HOUR_MS } from '../services/clock.js';
import { setSetting } from '../services/settings.js';
import type { Db } from './client.js';

const TABLES = [
  'mp_requests', 'mp_trackings', 'mp_orders', 'job_attempts', 'jobs', 'carrier_scans', 'buyer_messages', 'order_events',
  'shipments', 'emails', 'templates', 'llm_runs', 'orders', 'suppliers', 'settings',
];

/** Wipes every table and loads the synthetic seed. Times are anchored to `wallNow`. */
export async function resetAndSeed(db: Db, fixtures: Fixtures, wallNow: number): Promise<void> {
  const epoch = Math.floor(wallNow / 60_000) * 60_000;
  await db.transaction(async (tx) => {
    await tx.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    await setSetting(tx, 'epoch', new Date(epoch).toISOString());
    await setSetting(tx, 'offsetDays', 0);
    await setSetting(tx, 'marketplaceMode', 'normal');
    await setSetting(tx, 'nextBatch', 1);
    await setSetting(tx, 'mpRequestSeq', 0);

    for (const s of fixtures.suppliers.suppliers) {
      const { rows } = await tx.query<{ id: number }>(
        `INSERT INTO suppliers (name, sender_domain, layout, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
        [s.name, s.senderDomain, s.layout],
      );
      await tx.query(
        `INSERT INTO templates (supplier_id, version, status, source, spec, approved_at) VALUES ($1, 1, 'approved', 'seed', $2, $3)`,
        [rows[0]!.id, JSON.stringify(s.template), new Date(epoch).toISOString()],
      );
    }

    for (const o of fixtures.orders.orders) {
      await tx.query(
        `INSERT INTO orders (id, buyer_name, street, town, postal_code, items, supplier_name, placed_at, handling_deadline, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'awaiting_tracking')`,
        [
          o.id, o.buyer, o.street, o.town, o.postal, JSON.stringify(o.items), o.supplier,
          new Date(epoch - o.placedHoursAgo * HOUR_MS).toISOString(),
          new Date(epoch + o.deadlineInHours * HOUR_MS).toISOString(),
        ],
      );
      const cancelled = fixtures.orders.cancelledOnMarketplace.includes(o.id);
      await tx.query('INSERT INTO mp_orders (id, status) VALUES ($1, $2)', [o.id, cancelled ? 'cancelled' : 'open']);
    }

    for (const s of fixtures.scans.scans) {
      await tx.query('INSERT INTO carrier_scans (tracking_number, days_after_upload, status, location) VALUES ($1, $2, $3, $4)', [
        s.tracking, s.daysAfterUpload, s.status, s.location,
      ]);
    }
  });
}
