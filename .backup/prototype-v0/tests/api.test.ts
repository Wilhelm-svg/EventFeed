import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { createDb } from '../src/db';
import { exampleEvent } from '../src/schema';

const app = () => createApp({ db: createDb(':memory:'), now: () => new Date(2026, 5, 1, 10) });

describe('API basics', () => {
  it('GET /api returns the guide', async () => {
    const res = await request(app()).get('/api');
    expect(res.status).toBe(200);
    expect(res.body.howToUse.length).toBeGreaterThan(0);
    expect(res.body.status).toMatch(/Local prototype/);
  });

  it('GET /openapi.json returns the spec', async () => {
    const res = await request(app()).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.paths['/api/events/search']).toBeDefined();
  });

  it('valid POST returns 201 with id and verifyWith, and verifyWith finds it', async () => {
    const a = app();
    const res = await request(a).post('/api/events').send(exampleEvent);
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();

    const check = await request(a).get(res.body.verifyWith);
    expect(check.body.results.map((r: any) => r.id)).toContain(res.body.id);
  });

  it('invalid POST names each bad field and gives an example', async () => {
    const { name, ...noName } = exampleEvent;
    const res = await request(app()).post('/api/events').send({ ...noName, temporal: { type: 'dated', startDate: '6 March' } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/name/);
    expect(res.body.error.message).toMatch(/temporal\.startDate/);
    expect(res.body.error.problems).toContain('name is required');
    expect(res.body.error.validExample.temporal.type).toBe('dated');
  });

  it('validation messages are plain language and unknown fields are rejected', async () => {
    const res = await request(app()).post('/api/events').send({
      ...exampleEvent, foo: 1, datesConfirmed: 'yes', temporal: { type: 'seasonal', startMonth: 13, endMonth: 2 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.problems).toEqual(expect.arrayContaining([
      'temporal.startMonth must be at most 12, but got 13',
      'datesConfirmed must be a boolean, but got "yes"',
    ]));
    expect(res.body.error.message).toMatch(/unknown field\(s\) foo/);
    expect(res.body.error.validExample.temporal.type).toBe('seasonal');
  });

  it('missing temporal says it is required', async () => {
    const { temporal, ...rest } = exampleEvent;
    const res = await request(app()).post('/api/events').send(rest);
    expect(res.body.error.problems).toContain('temporal is required');
  });

  it('endDate before startDate reads cleanly', async () => {
    const res = await request(app()).post('/api/events').send({ ...exampleEvent, temporal: { type: 'dated', startDate: '2027-04-10', endDate: '2027-04-01' } });
    expect(res.body.error.problems).toContain('temporal.endDate must be on or after startDate');
  });

  it('region search reports which places matched', async () => {
    const a = app();
    await request(a).post('/api/events').send(exampleEvent);
    const res = await request(a).get('/api/events/search').query({ location: 'Western Cape' });
    expect(res.body.query.interpreted.matchedPlaces).toEqual(['Hermanus, Western Cape']);
  });

  it('weekly event without daysOfWeek is rejected', async () => {
    const res = await request(app()).post('/api/events').send({ ...exampleEvent, temporal: { type: 'recurring', frequency: 'weekly' } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/daysOfWeek/);
  });

  it('endDate before startDate and impossible dates are rejected', async () => {
    const res = await request(app()).post('/api/events').send({ ...exampleEvent, temporal: { type: 'dated', startDate: '2027-02-30', endDate: '2027-01-01' } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not a real calendar date/);
  });

  it('interests are normalised and an empty result lists the tags in use', async () => {
    const a = app();
    await request(a).post('/api/events').send(exampleEvent);
    const ok = await request(a).get('/api/events/search').query({ location: 'Hermanus', interests: 'Music' });
    expect(ok.body.results).toHaveLength(1);
    const none = await request(a).get('/api/events/search').query({ location: 'Hermanus', interests: 'Rock Climbing' });
    expect(none.body.query.interpreted.interests).toEqual(['rock-climbing']);
    expect(none.body.explanation).toMatch(/Interests used in Hermanus: concert, music/);
  });

  it('malformed JSON gets a readable error', async () => {
    const res = await request(app()).post('/api/events').set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/not valid JSON/);
  });

  it('duplicate POST returns 409 with the existing id', async () => {
    const a = app();
    const first = await request(a).post('/api/events').send(exampleEvent);
    const second = await request(a).post('/api/events').send(exampleEvent);
    expect(second.status).toBe(409);
    expect(second.body.existingId).toBe(first.body.id);
  });

  it('missing location explains itself', async () => {
    const res = await request(app()).get('/api/events/search');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/location is required/);
  });

  it('DELETE returns 405 listing supported operations', async () => {
    const res = await request(app()).delete('/api/events');
    expect(res.status).toBe(405);
    expect(res.body.error.suggestions.join(' ')).toMatch(/POST \/api\/events/);
  });

  it('unknown path returns 404 with guidance', async () => {
    const res = await request(app()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.suggestions.length).toBeGreaterThan(0);
  });

  it('/api/events/{id} returns 405 explaining how to verify instead', async () => {
    for (const method of ['get', 'put', 'delete'] as const) {
      const res = await request(app())[method]('/api/events/123');
      expect(res.status).toBe(405);
      expect(res.body.error.suggestions[0]).toMatch(/search/);
    }
  });

  it('invalid times are rejected', async () => {
    const res = await request(app()).post('/api/events').send({ ...exampleEvent, temporal: { type: 'dated', startDate: '2027-04-10', startTime: '25:99' } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/startTime/);
  });

  it('unknown temporal type gets a plain message', async () => {
    const res = await request(app()).post('/api/events').send({ ...exampleEvent, temporal: { type: 'weekly' } });
    expect(res.status).toBe(400);
    expect(res.body.error.problems[0]).toMatch(/^temporal\.type must be "dated", "seasonal" or "recurring"/);
  });

  it('wrong content type is a 415 naming the header', async () => {
    const res = await request(app()).post('/api/events').set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(415);
    expect(res.body.error.message).toMatch(/Content-Type: application\/json/);
  });

  it('duplicate check ignores a trailing slash on source.url', async () => {
    const a = app();
    await request(a).post('/api/events').send(exampleEvent);
    const res = await request(a).post('/api/events').send({ ...exampleEvent, source: { ...exampleEvent.source, url: 'https://example.com/jazz/' } });
    expect(res.status).toBe(409);
  });

  it('repeated interests params are combined, unknown params are warned about', async () => {
    const a = app();
    await request(a).post('/api/events').send(exampleEvent);
    const res = await request(a).get('/api/events/search?location=Hermanus&interests=music&interests=wildlife&limit=1');
    expect(res.body.query.interpreted.interests).toEqual(['music', 'wildlife']);
    expect(res.body.results).toHaveLength(0);
    expect(res.body.warnings[0]).toMatch(/limit/);
  });
});
