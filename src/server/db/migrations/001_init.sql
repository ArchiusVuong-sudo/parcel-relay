-- Core schema. One seller, synthetic data only.

CREATE TABLE settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE suppliers (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  sender_domain text NOT NULL UNIQUE,
  layout        text,
  status        text NOT NULL CHECK (status IN ('active', 'pending_approval', 'rejected')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_runs (
  id           serial PRIMARY KEY,
  supplier_id  int NOT NULL REFERENCES suppliers(id),
  email_id     int,
  mode         text NOT NULL CHECK (mode IN ('live', 'replay')),
  model        text NOT NULL,
  ok           boolean NOT NULL,
  error        text,
  duration_ms  int NOT NULL,
  cost_usd     double precision,
  num_turns    int,
  attempts     int NOT NULL DEFAULT 1,
  recorded_at  timestamptz,
  output       jsonb,
  trace        jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE templates (
  id          serial PRIMARY KEY,
  supplier_id int NOT NULL REFERENCES suppliers(id),
  version     int NOT NULL,
  status      text NOT NULL CHECK (status IN ('draft', 'approved', 'rejected')),
  source      text NOT NULL CHECK (source IN ('seed', 'llm')),
  spec        jsonb NOT NULL,
  test_result jsonb,
  llm_run_id  int REFERENCES llm_runs(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  UNIQUE (supplier_id, version)
);
-- At most one live template per supplier.
CREATE UNIQUE INDEX templates_one_approved ON templates (supplier_id) WHERE status = 'approved';

CREATE TABLE orders (
  id                text PRIMARY KEY,
  buyer_name        text NOT NULL,
  street            text NOT NULL,
  town              text NOT NULL,
  postal_code       text NOT NULL CHECK (postal_code ~ '^[0-9]{5}$'),
  items             jsonb NOT NULL,
  supplier_name     text NOT NULL,
  placed_at         timestamptz NOT NULL,
  handling_deadline timestamptz NOT NULL,
  status            text NOT NULL CHECK (status IN ('awaiting_tracking', 'uploading', 'uploaded', 'in_transit', 'delivered', 'cancelled', 'upload_failed')),
  carrier_code      text,
  tracking_number   text,
  shipment_id       int,
  uploaded_day      int,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE emails (
  id           serial PRIMARY KEY,
  message_id   text NOT NULL UNIQUE,
  batch        int NOT NULL,
  from_addr    text NOT NULL,
  from_name    text NOT NULL,
  subject      text NOT NULL,
  content_type text NOT NULL,
  blob_key     text NOT NULL,
  received_at  timestamptz NOT NULL,
  supplier_id  int REFERENCES suppliers(id),
  status       text NOT NULL CHECK (status IN ('received', 'drafting', 'waiting_approval', 'parsed', 'held', 'duplicate', 'failed')),
  parse_method text CHECK (parse_method IN ('rule', 'llm')),
  template_id  int REFERENCES templates(id),
  llm_calls    int NOT NULL DEFAULT 0,
  fields       jsonb,
  spans        jsonb,
  reason       text
);

CREATE TABLE shipments (
  id              serial PRIMARY KEY,
  email_id        int NOT NULL REFERENCES emails(id),
  supplier_id     int NOT NULL REFERENCES suppliers(id),
  carrier_code    text,
  carrier_label   text NOT NULL,
  tracking_number text NOT NULL,
  -- A resent email with the same tracking hits this key and is marked duplicate.
  dedupe_key      text NOT NULL UNIQUE,
  check_result    jsonb NOT NULL,
  status          text NOT NULL CHECK (status IN ('held', 'awaiting_approval', 'needs_review', 'matched')),
  order_id        text REFERENCES orders(id),
  match           jsonb,
  decided_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_events (
  id       serial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  at       timestamptz NOT NULL,
  kind     text NOT NULL,
  message  text NOT NULL,
  detail   jsonb
);
CREATE INDEX order_events_order ON order_events (order_id, id);

CREATE TABLE buyer_messages (
  id       serial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  kind     text NOT NULL CHECK (kind IN ('shipped', 'delivered')),
  body     text NOT NULL,
  sent_at  timestamptz NOT NULL,
  -- One message per stage per order, however often the monitor runs.
  UNIQUE (order_id, kind)
);

CREATE TABLE carrier_scans (
  id                serial PRIMARY KEY,
  tracking_number   text NOT NULL,
  days_after_upload int NOT NULL,
  status            text NOT NULL CHECK (status IN ('in_transit', 'delivered')),
  location          text NOT NULL,
  applied_at        timestamptz,
  UNIQUE (tracking_number, status)
);

CREATE TABLE jobs (
  id              serial PRIMARY KEY,
  kind            text NOT NULL,
  payload         jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status          text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'dead')),
  attempts        int NOT NULL DEFAULT 0,
  max_attempts    int NOT NULL,
  run_at          timestamptz NOT NULL,
  locked_at       timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs (run_at, id) WHERE status = 'queued';

CREATE TABLE job_attempts (
  id          serial PRIMARY KEY,
  job_id      int NOT NULL REFERENCES jobs(id),
  attempt     int NOT NULL,
  started_at  timestamptz NOT NULL,
  duration_ms int NOT NULL,
  outcome     text NOT NULL CHECK (outcome IN ('ok', 'retry', 'dead')),
  http_status int,
  code        text,
  message     text,
  next_run_at timestamptz
);

-- The simulated marketplace keeps its own tables, as a separate service would.
CREATE TABLE mp_orders (
  id     text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('open', 'cancelled'))
);

CREATE TABLE mp_trackings (
  id              serial PRIMARY KEY,
  order_id        text NOT NULL UNIQUE REFERENCES mp_orders(id),
  carrier_code    text NOT NULL,
  tracking_number text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mp_requests (
  id              serial PRIMARY KEY,
  seq             int NOT NULL,
  order_id        text NOT NULL,
  idempotency_key text,
  status_code     int NOT NULL,
  outcome         text NOT NULL,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE VIEW dashboard_tiles AS
SELECT
  (SELECT count(*) FROM orders WHERE status = 'awaiting_tracking')::int AS awaiting_tracking,
  (SELECT count(*) FROM orders WHERE status = 'uploading')::int AS uploading,
  (SELECT count(*) FROM orders WHERE status = 'uploaded')::int AS uploaded,
  (SELECT count(*) FROM orders WHERE status = 'in_transit')::int AS in_transit,
  (SELECT count(*) FROM orders WHERE status = 'delivered')::int AS delivered,
  (SELECT count(*) FROM emails WHERE status = 'held')::int AS held,
  (SELECT count(*) FROM shipments WHERE status IN ('needs_review', 'awaiting_approval'))::int AS needs_person,
  (SELECT count(*) FROM jobs WHERE status = 'dead')::int AS dead_letter,
  (SELECT count(*) FROM emails)::int AS emails_total,
  (SELECT count(*) FROM emails WHERE parse_method = 'rule')::int AS rule_parsed,
  (SELECT coalesce(sum(llm_calls), 0) FROM emails)::int AS llm_calls,
  (SELECT count(*) FROM buyer_messages)::int AS buyer_messages;
