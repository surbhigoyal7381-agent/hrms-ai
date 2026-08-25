import { describe, it, expect } from 'vitest';
import { isValidAt, planChange, assertBusinessDate, ValidationError } from '../src/temporal.js';

// Written from 20-requirements.md RULE-001..RULE-003, before reading the
// implementation. These are the boundary cases the requirements name.

describe('assertBusinessDate', () => {
  it('accepts a real date', () => {
    expect(assertBusinessDate('2026-09-01')).toBe('2026-09-01');
  });

  it('accepts 29 February in a leap year', () => {
    expect(assertBusinessDate('2024-02-29')).toBe('2024-02-29');
  });

  it('rejects 29 February in a non-leap year', () => {
    expect(() => assertBusinessDate('2026-02-29')).toThrow(ValidationError);
  });

  it('rejects a well-shaped but impossible date', () => {
    expect(() => assertBusinessDate('2026-02-30')).toThrow(ValidationError);
    expect(() => assertBusinessDate('2026-13-01')).toThrow(ValidationError);
  });

  it('rejects a timestamp, because business dates are dates', () => {
    expect(() => assertBusinessDate('2026-09-01T00:00:00Z')).toThrow(ValidationError);
  });
});

describe('isValidAt — the half-open interval [valid_from, valid_to)', () => {
  const v = { validFrom: '2023-04-01', validTo: '2026-09-01' };

  it('includes the day the version starts', () => {
    expect(isValidAt(v, '2023-04-01')).toBe(true);
  });

  it('includes the day before it ends', () => {
    expect(isValidAt(v, '2026-08-31')).toBe(true);
  });

  it('EXCLUDES the end date itself — this is the boundary that matters', () => {
    expect(isValidAt(v, '2026-09-01')).toBe(false);
  });

  it('excludes dates before it starts', () => {
    expect(isValidAt(v, '2023-03-31')).toBe(false);
  });

  it('treats a null valid_to as open-ended', () => {
    expect(isValidAt({ validFrom: '2026-09-01', validTo: null }, '2099-01-01')).toBe(true);
  });

  it('NEVER returns a zero-length superseded interval', () => {
    // This is the bug RULE-002 exists to prevent: without this clause the
    // point-in-time query returns two rows for one person and every headcount
    // downstream is double-counted.
    const superseded = { validFrom: '2026-09-01', validTo: '2026-09-01' };
    expect(isValidAt(superseded, '2026-09-01')).toBe(false);
    expect(isValidAt(superseded, '2026-08-31')).toBe(false);
  });
});

describe('planChange', () => {
  const initial = [
    { id: 'v1', validFrom: '2023-04-01', validTo: null, recordedAt: '2023-04-01T09:00:00Z' },
  ];

  it('closes the covering version and appends a new open one', () => {
    const plan = planChange(initial, '2026-09-01');
    expect(plan.close).toEqual({ id: 'v1', validTo: '2026-09-01' });
    expect(plan.insert).toEqual({ validFrom: '2026-09-01', validTo: null });
    expect(plan.supersededIds).toEqual([]);
  });

  it('supersedes a future-dated version when a retroactive change lands', () => {
    // The requirements' "nasty one": a transfer was recorded for 1 Sept, then
    // HR is told it actually happened on 15 Aug.
    const withFuture = [
      { id: 'v1', validFrom: '2023-04-01', validTo: '2026-09-01', recordedAt: '2023-04-01T09:00:00Z' },
      { id: 'v2', validFrom: '2026-09-01', validTo: null, recordedAt: '2026-08-22T14:32:00Z' },
    ];
    const plan = planChange(withFuture, '2026-08-15');
    expect(plan.close).toEqual({ id: 'v1', validTo: '2026-08-15' });
    expect(plan.supersededIds).toEqual(['v2']);
    expect(plan.insert).toEqual({ validFrom: '2026-08-15', validTo: null });
  });

  it('bounds the new version by the next surviving version', () => {
    const three = [
      { id: 'v1', validFrom: '2023-01-01', validTo: '2024-01-01', recordedAt: '2023-01-01T00:00:00Z' },
      { id: 'v2', validFrom: '2024-01-01', validTo: '2025-01-01', recordedAt: '2024-01-01T00:00:00Z' },
      { id: 'v3', validFrom: '2025-01-01', validTo: null, recordedAt: '2025-01-01T00:00:00Z' },
    ];
    // Change effective mid-v1: v2 and v3 start after, so they are superseded.
    const plan = planChange(three, '2023-06-01');
    expect(plan.close).toEqual({ id: 'v1', validTo: '2023-06-01' });
    expect(plan.supersededIds.sort()).toEqual(['v2', 'v3']);
  });

  it('ignores already-superseded zero-length versions', () => {
    const withDead = [
      { id: 'v1', validFrom: '2023-04-01', validTo: null, recordedAt: '2023-04-01T09:00:00Z' },
      { id: 'dead', validFrom: '2026-09-01', validTo: '2026-09-01', recordedAt: '2026-08-22T14:32:00Z' },
    ];
    const plan = planChange(withDead, '2026-10-01');
    expect(plan.supersededIds).toEqual([]);
    expect(plan.close).toEqual({ id: 'v1', validTo: '2026-10-01' });
  });

  it('rejects an invalid effective date', () => {
    expect(() => planChange(initial, '2026-02-30')).toThrow(ValidationError);
  });
});
