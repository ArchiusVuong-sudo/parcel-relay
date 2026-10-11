/** Client for the (simulated) marketplace API, as the upload worker sees it. */

export interface UploadRequest {
  orderId: string;
  carrierCode: string;
  trackingNumber: string;
  idempotencyKey: string;
}

export type UploadResult =
  | { kind: 'ok'; status: number; trackingId: number; replayed: boolean }
  | { kind: 'retryable'; status: number | null; code: string; message: string; retryAfterMs?: number }
  | { kind: 'permanent'; status: number; code: string; message: string };

export interface MarketplaceClient {
  uploadTracking(req: UploadRequest): Promise<UploadResult>;
}

export class HttpMarketplaceClient implements MarketplaceClient {
  constructor(
    private readonly baseUrl: () => string,
    private readonly timeoutMs = 1500,
  ) {}

  async uploadTracking(req: UploadRequest): Promise<UploadResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl()}/sim/marketplace/orders/${encodeURIComponent(req.orderId)}/tracking`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': req.idempotencyKey },
        body: JSON.stringify({ carrier: req.carrierCode, trackingNumber: req.trackingNumber }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { kind: 'retryable', status: null, code: 'TIMEOUT', message: `No answer within ${this.timeoutMs} ms (the request may have gone through)` };
      }
      return { kind: 'retryable', status: null, code: 'NETWORK', message: (err as Error).message };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string; trackingId?: number; replayed?: boolean };
    if (res.ok) return { kind: 'ok', status: res.status, trackingId: body.trackingId ?? 0, replayed: body.replayed ?? false };
    const code = body.error ?? `HTTP_${res.status}`;
    const message = body.message ?? res.statusText;
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after'));
      return { kind: 'retryable', status: 429, code, message, ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}) };
    }
    if (res.status >= 500) return { kind: 'retryable', status: res.status, code, message };
    return { kind: 'permanent', status: res.status, code, message };
  }
}
