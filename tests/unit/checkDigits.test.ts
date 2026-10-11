import { describe, expect, it } from 'vitest';
import { gs1CheckDigit, isValidGs1, isValidLuhn, isValidS10, luhnCheckDigit, s10CheckDigit } from '../../src/server/domain/checkDigits.js';

describe('S10 check digit', () => {
  it('matches the published example serial', () => {
    expect(s10CheckDigit('12345678')).toBe(5);
    expect(isValidS10('AB123456785XX')).toBe(true);
  });
  it('maps 10 to 0 and 11 to 5', () => {
    // sum % 11 === 1 gives 10 -> 0; sum % 11 === 0 gives 11 -> 5
    const serials = Array.from({ length: 2000 }, (_, i) => String(10_000_000 + i * 37));
    const digits = new Set(serials.map(s10CheckDigit));
    expect([...digits].every((d) => d >= 0 && d <= 9)).toBe(true);
  });
  it('rejects a mistyped serial and a bad shape', () => {
    expect(isValidS10('AB123456786XX')).toBe(false);
    expect(isValidS10('AB12345678XX')).toBe(false);
    expect(isValidS10('ab123456785xx')).toBe(false);
  });
  it('validates the fixture numbers', () => {
    for (const n of ['KP407318267ZZ', 'KP407319072ZZ', 'KP512093445ZZ']) expect(isValidS10(n)).toBe(true);
  });
});

describe('GS1 mod-10', () => {
  it('matches a well-known GTIN-13', () => {
    expect(gs1CheckDigit('400638133393')).toBe(1);
    expect(isValidGs1('4006381333931')).toBe(true);
  });
  it('catches a single-digit typo', () => {
    expect(isValidGs1('003840217755005278')).toBe(true);
    expect(isValidGs1('003840217755006278')).toBe(false);
  });
  it('misses a transposition of digits that differ by 5 (a known limit of mod-10)', () => {
    expect(isValidGs1('003840217755005728')).toBe(true);
  });
  it('rejects non-digits', () => {
    expect(isValidGs1('00384021775500A278')).toBe(false);
  });
});

describe('Luhn', () => {
  it('matches the textbook example', () => {
    expect(luhnCheckDigit('7992739871')).toBe(3);
    expect(isValidLuhn('79927398713')).toBe(true);
    expect(isValidLuhn('79927398710')).toBe(false);
  });
  it('catches adjacent transpositions', () => {
    expect(isValidLuhn('702155380463')).toBe(true);
    expect(isValidLuhn('720155380463')).toBe(false);
  });
});
