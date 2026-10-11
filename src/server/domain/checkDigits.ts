/**
 * Public check-digit methods used by the invented carriers.
 * Each function takes the full tracking number and says whether its check digit is right.
 */

export type CheckMethod = 's10' | 'gs1_mod10' | 'luhn' | 'none';

const S10_WEIGHTS = [8, 6, 4, 2, 3, 5, 9, 7] as const;

/** UPU S10: 2 letters, 8 serial digits, 1 check digit, 2 letters. */
export function s10CheckDigit(serial: string): number {
  if (!/^\d{8}$/.test(serial)) throw new Error('S10 serial must be 8 digits');
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(serial[i]) * S10_WEIGHTS[i]!;
  const check = 11 - (sum % 11);
  if (check === 10) return 0;
  if (check === 11) return 5;
  return check;
}

export function isValidS10(value: string): boolean {
  const m = /^[A-Z]{2}(\d{8})(\d)[A-Z]{2}$/.exec(value);
  if (!m) return false;
  return s10CheckDigit(m[1]!) === Number(m[2]);
}

/** GS1 mod-10 (as used by GTIN and SSCC): weights 3,1,3,... from the rightmost data digit. */
export function gs1CheckDigit(data: string): number {
  if (!/^\d+$/.test(data)) throw new Error('GS1 data must be digits');
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const digit = Number(data[data.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidGs1(value: string): boolean {
  if (!/^\d{2,}$/.test(value)) return false;
  return gs1CheckDigit(value.slice(0, -1)) === Number(value.at(-1));
}

/** Luhn: double every second digit from the right, starting next to the check digit. */
export function luhnCheckDigit(data: string): number {
  if (!/^\d+$/.test(data)) throw new Error('Luhn data must be digits');
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    let digit = Number(data[data.length - 1 - i]);
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidLuhn(digits: string): boolean {
  if (!/^\d{2,}$/.test(digits)) return false;
  return luhnCheckDigit(digits.slice(0, -1)) === Number(digits.at(-1));
}
