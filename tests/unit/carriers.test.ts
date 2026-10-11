import { describe, expect, it } from 'vitest';
import { checkTracking, findCarrier, normalizeTracking } from '../../src/server/domain/carriers.js';
import { ACCEPTED_CARRIERS } from '../../src/server/services/marketplace.js';

describe('carrier lookup', () => {
  it('finds carriers by name or alias, any case and spacing', () => {
    expect(findCarrier('Kestrelpost')?.code).toBe('kestrelpost');
    expect(findCarrier('  tidelane  GROUND ')?.code).toBe('tidelane');
    expect(findCarrier('Swiftmere')?.code).toBe('swiftmere');
    expect(findCarrier('Parcel Owl')).toBeUndefined();
  });
  it('normalizes spaces and dashes in tracking numbers', () => {
    expect(normalizeTracking('kp 4073-1826 7zz')).toBe('KP407318267ZZ');
  });
});

describe('checkTracking', () => {
  const accepted = ACCEPTED_CARRIERS;
  it('accepts a valid number from an accepted carrier', () => {
    const r = checkTracking('Kestrelpost', 'KP407318267ZZ', accepted);
    expect(r).toMatchObject({ ok: true, carrierCode: 'kestrelpost', method: 's10' });
  });
  it('holds a check digit mismatch', () => {
    expect(checkTracking('Tidelane Ground', '003840217755006278', accepted)).toMatchObject({ ok: false, reason: 'check_digit_mismatch' });
  });
  it('holds a carrier the marketplace does not accept, even with a valid number', () => {
    expect(checkTracking('Quillmoor Courier', 'QC204118839', accepted)).toMatchObject({ ok: false, reason: 'carrier_not_accepted' });
  });
  it('holds a number in the wrong format for its carrier', () => {
    expect(checkTracking('Swiftmere Express', 'KP407318267ZZ', accepted)).toMatchObject({ ok: false, reason: 'bad_format' });
  });
  it('holds an unknown carrier', () => {
    expect(checkTracking('Parcel Owl', '123', accepted)).toMatchObject({ ok: false, reason: 'unknown_carrier', carrierCode: null });
  });
  it('runs the check digit before the acceptance rule', () => {
    expect(checkTracking('Swiftmere Express', 'SX702155380464', ['kestrelpost'])).toMatchObject({ reason: 'check_digit_mismatch' });
  });
});
