import { describe, it, expect } from 'vitest';
import events from '../data/events.json';
import { eventSchema } from '../src/schema';

describe('curated events', () => {
  it('has 5 events', () => expect(events).toHaveLength(5));

  it.each(events.map((e) => [e.name, e]))('%s passes the schema and has a source', (_name, e) => {
    const parsed = eventSchema.safeParse(e);
    expect(parsed.error?.issues ?? []).toEqual([]);
    expect(e.source.url).toMatch(/^https:\/\//);
    expect(e.source.checkedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('whale season says sightings are not guaranteed', () => {
    const whales = events.find((e) => e.temporal.type === 'seasonal')!;
    expect(whales.whatToExpect).toMatch(/not guaranteed/);
  });
});
