import { describe, expect, it } from 'vitest';
import { normalizeBrazilianPhone } from '../src/domain/phone.js';

describe('normalizeBrazilianPhone', () => {
  it.each([
    ['(11) 99999-9999', '+5511999999999'],
    ['55 11 99999 9999', '+5511999999999'],
    ['+55 (21) 3333-4444', '+552133334444'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeBrazilianPhone(input)).toBe(expected);
  });

  it('rejects incomplete numbers', () => {
    expect(() => normalizeBrazilianPhone('9999-9999')).toThrow();
  });
});

