const dateTime = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export const fmtDateTime = (iso: string) => dateTime.format(new Date(iso));
export const fmtClock = (iso: string) => clock.format(new Date(iso));
export const fmtTime = (iso: string) => time.format(new Date(iso));
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
export const fmtUsd = (usd: number | null) => (usd === null ? 'n/a' : `$${usd.toFixed(4)}`);
export const pct = (n: number) => `${Math.round(n * 100)}%`;

export const FIELD_LABEL: Record<string, string> = {
  tracking_number: 'Tracking number',
  carrier: 'Carrier',
  buyer_name: 'Buyer',
  street: 'Street',
  postal_code: 'Postal code',
  items: 'Items',
};

export const FIELD_COLOR: Record<string, string> = {
  tracking_number: 'bg-indigo-100 text-indigo-900 ring-indigo-300',
  carrier: 'bg-sky-100 text-sky-900 ring-sky-300',
  buyer_name: 'bg-emerald-100 text-emerald-900 ring-emerald-300',
  street: 'bg-amber-100 text-amber-900 ring-amber-300',
  postal_code: 'bg-rose-100 text-rose-900 ring-rose-300',
  items: 'bg-violet-100 text-violet-900 ring-violet-300',
};

export const CRITERION_LABEL: Record<string, string> = {
  name: 'Buyer name',
  street: 'Street',
  postal: 'Postal code',
  items: 'Item words',
  date: 'Date window',
};

export const ORDER_STATUS_LABEL: Record<string, string> = {
  awaiting_tracking: 'Awaiting tracking',
  uploading: 'Uploading',
  uploaded: 'Uploaded',
  in_transit: 'In transit',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  upload_failed: 'Upload failed',
};

export const CARRIER_NAME: Record<string, string> = {
  kestrelpost: 'Kestrelpost',
  tidelane: 'Tidelane Ground',
  swiftmere: 'Swiftmere Express',
  quillmoor_courier: 'Quillmoor Courier',
};
