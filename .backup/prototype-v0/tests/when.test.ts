import { describe, it, expect } from 'vitest';
import { parseWhen } from '../src/when';

// Frozen clock: Monday 1 June 2026, local time.
const NOW = new Date(2026, 5, 1, 10, 0, 0);

const range = (text: string) => {
  const r = parseWhen(text, NOW);
  if (!r.ok) throw new Error(r.message);
  return r;
};

describe('parseWhen', () => {
  it('month and year covers the whole month', () => {
    expect(range('August 2027').range).toEqual({ start: '2027-08-01', end: '2027-08-31' });
  });

  it('ISO date is a single day', () => {
    expect(range('2027-08-15').range).toEqual({ start: '2027-08-15', end: '2027-08-15' });
  });

  it('"this Saturday" uses the injected clock', () => {
    expect(range('this Saturday').range).toEqual({ start: '2026-06-06', end: '2026-06-06' });
  });

  it('month without a year picks the next one and says so', () => {
    const r = range('March');
    expect(r.range).toEqual({ start: '2027-03-01', end: '2027-03-31' });
    expect(r.assumptions[0]).toMatch(/2027/);
  });

  it('explicit range', () => {
    expect(range('1 June 2027 to 15 June 2027').range).toEqual({ start: '2027-06-01', end: '2027-06-15' });
  });

  it('reversed range is put in order and the interpretation is echoed', () => {
    const r = range('15 June 2027 to 1 June 2027');
    expect(r.range).toEqual({ start: '2027-06-01', end: '2027-06-15' });
    expect(r.assumptions.join(' ')).toMatch(/as 2027-06-01 to 2027-06-15/);
  });

  it('"next week" is Monday to Sunday of the following week', () => {
    expect(range('next week').range).toEqual({ start: '2026-06-08', end: '2026-06-14' });
  });

  it('"this weekend" is Saturday and Sunday', () => {
    expect(range('this weekend').range).toEqual({ start: '2026-06-06', end: '2026-06-07' });
  });

  it('a bare year covers the whole year', () => {
    expect(range('2027').range).toEqual({ start: '2027-01-01', end: '2027-12-31' });
  });

  it('every interpretation is echoed in assumptions', () => {
    expect(range('this Saturday').assumptions).toEqual(['Interpreted "this Saturday" as 2026-06-06 to 2026-06-06.']);
  });

  it('impossible ISO date says so', () => {
    const r = parseWhen('2027-02-30', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/not a real calendar date/);
  });

  it('season words are rejected with a southern-hemisphere hint', () => {
    const r = parseWhen('next summer', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toMatch(/southern hemisphere/);
      expect(r.suggestions.length).toBeGreaterThan(0);
    }
  });

  it('nonsense is rejected with examples', () => {
    const r = parseWhen('whenever', NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.suggestions).toContain('August 2027');
  });
});
