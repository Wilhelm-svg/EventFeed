import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import events from '../data/events.json';
import { createApp } from '../src/app';
import { createDb } from '../src/db';

// Full flow: upload the 5 curated events through the API, then query them back.
// Clock frozen at Monday 1 June 2026 so "this Saturday" is 6 June 2026.
const app = createApp({ db: createDb(':memory:'), now: () => new Date(2026, 5, 1, 10) });
const search = (q: Record<string, string>) => request(app).get('/api/events/search').query(q);
const names = (res: any) => res.body.results.map((r: any) => r.name).sort();

const WHALES = 'Southern Right Whale Season';
const FESTIVAL = 'Hermanus Whale Festival';
const FYNARTS = 'Hermanus FynArts Festival 2027';
const MARKET = 'Hermanus Country Market';
const CONCERT = 'FynArts Old Harbour Sunset Concert';

beforeAll(async () => {
  for (const e of events) {
    const res = await request(app).post('/api/events').send(e);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  }
});

describe('full flow on the curated data', () => {
  it('location only returns all 5', async () => {
    expect(names(await search({ location: 'Hermanus' }))).toEqual([CONCERT, FYNARTS, MARKET, FESTIVAL, WHALES].sort());
  });

  it('1. August 2027: whale season (with caveat) and the market only', async () => {
    const res = await search({ location: 'Hermanus', when: 'August 2027' });
    expect(names(res)).toEqual([MARKET, WHALES].sort());
    const whales = res.body.results.find((r: any) => r.name === WHALES);
    expect(whales.whatToExpect).toMatch(/not guaranteed/);
    const market = res.body.results.find((r: any) => r.name === MARKET);
    expect(market.matchReasons.join(' ')).toMatch(/4 date\(s\)/); // 7, 14, 21, 28 August 2027
  });

  // FynArts 2027 dates are confirmed by the organiser (24 June to 4 July), so no tentative flag.
  it('2. June 2027: FynArts, whale season and the market', async () => {
    const res = await search({ location: 'Hermanus', when: 'June 2027' });
    expect(names(res)).toEqual([FYNARTS, MARKET, WHALES].sort());
    expect(res.body.results.find((r: any) => r.name === FYNARTS).datesConfirmed).toBe(true);
  });

  // The Whale Festival is the tentative case: annual, 2027 dates not announced.
  it('3. September 2027: Whale Festival (unconfirmed dates), whale season and the market', async () => {
    const res = await search({ location: 'Hermanus', when: 'September 2027' });
    expect(names(res)).toEqual([MARKET, FESTIVAL, WHALES].sort());
    const fest = res.body.results.find((r: any) => r.name === FESTIVAL);
    expect(fest.datesConfirmed).toBe(false);
    expect(fest.whenText).toMatch(/not yet confirmed/);
    expect(fest.missingInformation).toContain('confirmed dates');
  });

  it('4. "next summer" is a 400 with a southern-hemisphere hint', async () => {
    const res = await search({ location: 'Hermanus', when: 'next summer' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/southern hemisphere/);
  });

  it('5. Cape Town: empty, explained, suggests Hermanus', async () => {
    const res = await search({ location: 'Cape Town' });
    expect(res.body.results).toEqual([]);
    expect(res.body.explanation).toMatch(/Hermanus/);
    expect(res.body.suggestions.join(' ')).toMatch(/location=Hermanus/);
  });

  it('6. POST with no name is a 400 naming the field', async () => {
    const { name, ...rest } = events[0];
    const res = await request(app).post('/api/events').send(rest);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/name/);
  });

  it('7. DELETE is a 405 listing supported operations', async () => {
    const res = await request(app).delete('/api/events');
    expect(res.status).toBe(405);
  });

  it('8. uploading the same event again is a 409', async () => {
    const res = await request(app).post('/api/events').send(events[3]);
    expect(res.status).toBe(409);
    expect(res.body.existingId).toBeTruthy();
  });

  it('9. "this Saturday" (6 June 2026) returns the market and whale season', async () => {
    const res = await search({ location: 'Hermanus', when: 'this Saturday' });
    expect(res.body.query.interpreted.dateRange).toEqual({ start: '2026-06-06', end: '2026-06-06' });
    expect(names(res)).toEqual([MARKET, WHALES].sort());
  });

  it('interests filter: family-friendly in September 2027', async () => {
    const res = await search({ location: 'Hermanus', when: 'September 2027', interests: 'family-friendly' });
    expect(names(res)).toEqual([MARKET, FESTIVAL].sort());
  });

  it('concert lists what is still unknown', async () => {
    const res = await search({ location: 'Hermanus', when: '2027-03-06' });
    const concert = res.body.results.find((r: any) => r.name === CONCERT);
    expect(concert.missingInformation).toEqual(expect.arrayContaining(['start time', 'venue', 'price']));
  });
});
