/** Row shapes as PGlite returns them (timestamptz columns come back as Date). */

export interface EmailRow {
  id: number;
  message_id: string;
  batch: number;
  from_addr: string;
  from_name: string;
  subject: string;
  content_type: string;
  blob_key: string;
  received_at: Date;
  supplier_id: number | null;
  status: 'received' | 'drafting' | 'waiting_approval' | 'parsed' | 'held' | 'duplicate' | 'failed';
  parse_method: 'rule' | 'llm' | null;
  template_id: number | null;
  llm_calls: number;
  fields: Record<string, string> | null;
  spans: { field: string; start: number; end: number }[] | null;
  reason: string | null;
}

export interface SupplierRow {
  id: number;
  name: string;
  sender_domain: string;
  layout: string | null;
  status: 'active' | 'pending_approval' | 'rejected';
  created_at: Date;
}

export interface TemplateRow {
  id: number;
  supplier_id: number;
  version: number;
  status: 'draft' | 'approved' | 'rejected';
  source: 'seed' | 'llm';
  spec: { flags: string; patterns: Record<string, string> };
  test_result: { passed: boolean } | null;
  llm_run_id: number | null;
  created_at: Date;
  approved_at: Date | null;
}

export interface OrderRow {
  id: string;
  buyer_name: string;
  street: string;
  town: string;
  postal_code: string;
  items: { title: string; qty: number }[];
  supplier_name: string;
  placed_at: Date;
  handling_deadline: Date;
  status: 'awaiting_tracking' | 'uploading' | 'uploaded' | 'in_transit' | 'delivered' | 'cancelled' | 'upload_failed';
  carrier_code: string | null;
  tracking_number: string | null;
  shipment_id: number | null;
  uploaded_day: number | null;
}

export interface ShipmentRow {
  id: number;
  email_id: number;
  supplier_id: number;
  carrier_code: string | null;
  carrier_label: string;
  tracking_number: string;
  dedupe_key: string;
  check_result: Record<string, unknown>;
  status: 'held' | 'awaiting_approval' | 'needs_review' | 'matched';
  order_id: string | null;
  match: Record<string, unknown> | null;
  decided_by: string | null;
}
