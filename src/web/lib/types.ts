/** Response shapes of the Fastify API, as the dashboard uses them. */

export type OrderStatus = 'awaiting_tracking' | 'uploading' | 'uploaded' | 'in_transit' | 'delivered' | 'cancelled' | 'upload_failed';
export type EmailStatus = 'received' | 'drafting' | 'waiting_approval' | 'parsed' | 'held' | 'duplicate' | 'failed';
export type FieldName = 'tracking_number' | 'carrier' | 'buyer_name' | 'street' | 'postal_code' | 'items';

export interface Meta {
  llm: { mode: 'live' | 'replay'; reason: string; model: string };
  sim: { now: string; day: number; epoch: string };
  marketplaceMode: 'normal' | 'flaky';
  seller: string;
  inbox: { nextBatch: number; totalBatches: number; nextLabel: string | null; processing: boolean };
}

export interface Tiles {
  awaiting_tracking: number;
  uploading: number;
  uploaded: number;
  in_transit: number;
  delivered: number;
  held: number;
  needs_person: number;
  dead_letter: number;
  emails_total: number;
  rule_parsed: number;
  llm_calls: number;
  buyer_messages: number;
}

export interface LateRisk {
  orderId: string;
  buyerName: string;
  supplierName: string;
  deadline: string;
  hoursOverdue: number;
  hoursLeft: number;
  state: 'overdue' | 'due_soon';
  note: string | null;
}

export interface Activity {
  id: number;
  orderId: string;
  at: string;
  kind: string;
  message: string;
  buyerName: string;
}

export interface Overview {
  tiles: Tiles;
  lateRisk: LateRisk[];
  activity: Activity[];
}

export interface TrackingCheck {
  ok: boolean;
  reason?: string;
  carrierCode: string | null;
  carrierName: string;
  method: string | null;
  detail: string;
}

export interface EmailListItem {
  id: number;
  batch: number;
  fromName: string;
  fromAddr: string;
  subject: string;
  receivedAt: string;
  status: EmailStatus;
  parseMethod: 'rule' | 'llm' | null;
  llmCalls: number;
  reason: string | null;
  contentType: string;
  supplierName: string | null;
  supplierStatus: string | null;
  shipmentId: number | null;
  shipmentStatus: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  check: TrackingCheck | null;
  orderId: string | null;
}

export interface Breakdown {
  criterion: 'name' | 'street' | 'postal' | 'items' | 'date';
  weight: number;
  similarity: number;
  points: number;
  note: string;
}

export interface Candidate {
  orderId: string;
  score: number;
  breakdown: Breakdown[];
}

export interface MatchDecision {
  kind: 'auto' | 'review' | 'none';
  orderId?: string;
  score?: number;
  lead?: number;
  reason?: string;
  candidates: Candidate[];
}

export interface EmailDetail extends EmailListItem {
  body: string;
  fields: Partial<Record<FieldName, string>> | null;
  spans: { field: FieldName; start: number; end: number }[];
  match: MatchDecision | null;
  template: { id: number; version: number; source: 'seed' | 'llm'; status: string } | null;
  blobKey: string;
}

export interface OrderItem {
  title: string;
  qty: number;
}

export interface OrderListItem {
  id: string;
  buyerName: string;
  town: string;
  items: OrderItem[];
  supplierName: string;
  status: OrderStatus;
  carrierCode: string | null;
  trackingNumber: string | null;
  placedAt: string;
  deadline: string;
  overdue: boolean;
}

export interface OrderDetail {
  order: {
    id: string;
    buyerName: string;
    street: string;
    town: string;
    postalCode: string;
    items: OrderItem[];
    supplierName: string;
    placedAt: string;
    deadline: string;
    status: OrderStatus;
    carrierCode: string | null;
    trackingNumber: string | null;
  };
  match: { decidedBy: 'auto' | 'reviewer' | null; emailId: number; candidate: Candidate | null; candidates: Candidate[] } | null;
  events: { id: number; at: string; kind: string; message: string }[];
  messages: { id: number; kind: 'shipped' | 'delivered'; body: string; sentAt: string }[];
  marketplace: { tracking: { carrierCode: string; trackingNumber: string; createdAt: string } | null; trackings: number };
}

export interface JobView {
  id: number;
  kind: string;
  orderId: string | null;
  status: 'queued' | 'running' | 'done' | 'dead';
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  idempotencyKey: string;
  history: { attempt: number; outcome: 'ok' | 'retry' | 'dead'; httpStatus: number | null; code: string | null; message: string | null; durationMs: number; startedAt: string; nextRunAt: string | null }[];
}

export interface Uploads {
  jobs: JobView[];
  marketplace: {
    orders: { id: string; status: string; trackings: number; carrier: string | null; trackingNumber: string | null; requests: number }[];
    requests: { seq: number; orderId: string; statusCode: number; outcome: string; at: string }[];
  };
}

export interface ReviewItem {
  shipmentId: number;
  emailId: number;
  supplierName: string;
  subject: string;
  receivedAt: string;
  carrier: string;
  trackingNumber: string;
  fields: Partial<Record<FieldName, string>>;
  reason: 'tie' | 'low_score' | 'no_match';
  candidates: (Candidate & {
    order: { id: string; buyerName: string; street: string; town: string; postalCode: string; items: OrderItem[]; status: OrderStatus; placedAt: string; deadline: string } | null;
  })[];
}

export interface FieldTest {
  field: FieldName;
  expected: string;
  got: string | null;
  pass: boolean;
  issues: { rule: string; message: string }[];
}

export interface TemplateView {
  id: number;
  version: number;
  status: 'draft' | 'approved' | 'rejected';
  source: 'seed' | 'llm';
  spec: { flags: string; patterns: Record<FieldName, string> };
  test_result: { passed: boolean; summary: string; fields: FieldTest[] } | null;
  llm_run_id: number | null;
  created_at: string;
  approved_at: string | null;
}

export interface TraceStep {
  kind: string;
  label: string;
  atMs: number;
  detail?: unknown;
}

export interface LlmRun {
  id: number;
  mode: 'live' | 'replay';
  model: string;
  ok: boolean;
  error: string | null;
  duration_ms: number;
  cost_usd: number | null;
  num_turns: number | null;
  attempts: number;
  recorded_at: string | null;
  output: {
    fields: Record<FieldName, string>;
    confidence: number;
    notes: string;
    template: { flags: string; patterns: Record<FieldName, string> };
    fallbackReason: string | null;
    replayMs: number | null;
  } | null;
  trace: TraceStep[];
  created_at: string;
}

export interface SupplierView {
  id: number;
  name: string;
  sender_domain: string;
  layout: string | null;
  status: 'active' | 'pending_approval' | 'rejected';
  templates: TemplateView[];
  runs: LlmRun[];
  stats: { emails: number; rule: number; llm_calls: number };
}

export interface BuyerMessage {
  id: number;
  orderId: string;
  kind: 'shipped' | 'delivered';
  body: string;
  sentAt: string;
  buyerName: string;
}
