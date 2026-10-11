import { isValidGs1, isValidLuhn, isValidS10, type CheckMethod } from './checkDigits.js';

/** Invented carriers. Formats follow public check-digit schemes; names and prefixes are made up. */
export interface Carrier {
  code: string;
  name: string;
  aliases: string[];
  format: RegExp;
  formatHint: string;
  checkMethod: CheckMethod;
  /** A valid synthetic number, used to test that templates are not tied to one carrier. */
  example: string;
}

export const CARRIERS: readonly Carrier[] = [
  {
    code: 'kestrelpost',
    name: 'Kestrelpost',
    aliases: ['kestrelpost', 'kestrel post', 'kestrel'],
    format: /^[A-Z]{2}\d{9}[A-Z]{2}$/,
    formatHint: '2 letters, 9 digits, 2 letters (S10, last digit is the check digit)',
    checkMethod: 's10',
    example: 'KP602184379ZZ',
  },
  {
    code: 'tidelane',
    name: 'Tidelane Ground',
    aliases: ['tidelane ground', 'tidelane'],
    format: /^\d{18}$/,
    formatHint: '18 digits (GS1 mod-10 check digit at the end)',
    checkMethod: 'gs1_mod10',
    example: '003840217755009016',
  },
  {
    code: 'swiftmere',
    name: 'Swiftmere Express',
    aliases: ['swiftmere express', 'swiftmere'],
    format: /^SX\d{12}$/,
    formatHint: '"SX" then 12 digits (Luhn check digit at the end)',
    checkMethod: 'luhn',
    example: 'SX702155309777',
  },
  {
    code: 'quillmoor_courier',
    name: 'Quillmoor Courier',
    aliases: ['quillmoor courier', 'qm courier'],
    format: /^QC\d{9}$/,
    formatHint: '"QC" then 9 digits (no check digit)',
    checkMethod: 'none',
    example: 'QC100482736',
  },
];

export function normalizeCarrierName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function findCarrier(raw: string): Carrier | undefined {
  const name = normalizeCarrierName(raw);
  return CARRIERS.find((c) => c.aliases.includes(name) || normalizeCarrierName(c.name) === name);
}

export function normalizeTracking(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, '');
}

export type TrackingCheck =
  | { ok: true; carrierCode: string; carrierName: string; method: CheckMethod; detail: string }
  | {
      ok: false;
      reason: 'unknown_carrier' | 'bad_format' | 'check_digit_mismatch' | 'carrier_not_accepted';
      carrierCode: string | null;
      carrierName: string;
      method: CheckMethod | null;
      detail: string;
    };

export const HOLD_REASON_TEXT: Record<Exclude<TrackingCheck, { ok: true }>['reason'], string> = {
  unknown_carrier: 'unknown carrier',
  bad_format: 'tracking format invalid',
  check_digit_mismatch: 'check digit mismatch',
  carrier_not_accepted: 'carrier not accepted',
};

function passesCheck(method: CheckMethod, tracking: string): boolean {
  switch (method) {
    case 's10':
      return isValidS10(tracking);
    case 'gs1_mod10':
      return isValidGs1(tracking);
    case 'luhn':
      return isValidLuhn(tracking.replace(/^[A-Z]+/, ''));
    case 'none':
      return true;
  }
}

const METHOD_LABEL: Record<CheckMethod, string> = {
  s10: 'S10 check digit',
  gs1_mod10: 'GS1 mod-10 check digit',
  luhn: 'Luhn check digit',
  none: 'format only',
};

/**
 * Checks a tracking number before anything is queued:
 * known carrier, its format, its check digit, then whether the marketplace accepts the carrier.
 */
export function checkTracking(carrierRaw: string, trackingRaw: string, acceptedCarrierCodes: readonly string[]): TrackingCheck {
  const carrier = findCarrier(carrierRaw);
  const tracking = normalizeTracking(trackingRaw);
  if (!carrier) {
    return { ok: false, reason: 'unknown_carrier', carrierCode: null, carrierName: carrierRaw, method: null, detail: `No known carrier named "${carrierRaw}"` };
  }
  const base = { carrierCode: carrier.code, carrierName: carrier.name, method: carrier.checkMethod };
  if (!carrier.format.test(tracking)) {
    return { ok: false, reason: 'bad_format', ...base, detail: `Expected ${carrier.formatHint}` };
  }
  if (!passesCheck(carrier.checkMethod, tracking)) {
    return { ok: false, reason: 'check_digit_mismatch', ...base, detail: `${METHOD_LABEL[carrier.checkMethod]} does not match` };
  }
  if (!acceptedCarrierCodes.includes(carrier.code)) {
    return { ok: false, reason: 'carrier_not_accepted', ...base, detail: `${carrier.name} is not on the marketplace carrier list` };
  }
  return { ok: true, ...base, detail: `${METHOD_LABEL[carrier.checkMethod]} valid` };
}
