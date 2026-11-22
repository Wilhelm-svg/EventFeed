import express, { type Request, type Response, type NextFunction } from 'express';
import type { Db } from './db.js';
import { eventSchema, uploadExamples, type StoredEvent } from './schema.js';
import { parseWhen } from './when.js';
import { matchWhen } from './match.js';
import { present } from './present.js';
import { openapi } from './openapi.js';

const SUPPORTED = [
  'GET /api - plain-language guide',
  'GET /openapi.json - machine-readable spec',
  'GET /api/events/search?location=Hermanus&when=August 2027&interests=family-friendly',
  'POST /api/events - add one event (JSON body)',
];

function fail(res: Response, status: number, message: string, suggestions: string[], receivedInput?: unknown) {
  res.status(status).json({ error: { message, suggestions, receivedInput } });
}

/** Rewrites a Zod issue as one plain-language sentence about one field. */
function plainIssue(i: any, body: any): string {
  const field = i.path.join('.') || 'body';
  const value = i.path.reduce((o: any, k: any) => (o == null ? undefined : o[k]), body);
  if (i.code === 'unrecognized_keys') return `unknown field(s) ${i.keys.join(', ')}: remove them (see GET /api uploadExamples for allowed fields)`;
  if (value === undefined && i.code !== 'custom') return `${field} is required`;
  if (i.code === 'invalid_type') return `${field} must be ${i.expected === 'array' ? 'a list' : `a ${i.expected}`}, but got ${JSON.stringify(value)}`;
  if (i.code === 'too_big') return `${field} must be at most ${i.maximum}, but got ${JSON.stringify(value)}`;
  if (i.code === 'too_small') return i.origin === 'array' ? `${field} needs at least ${i.minimum} item(s)` : `${field} must be at least ${i.minimum}`;
  if (i.code === 'invalid_value') return `${field} must be one of ${i.values.map((v: any) => JSON.stringify(v)).join(', ')}, but got ${JSON.stringify(value)}`;
  return `${field} ${i.message.replace(/^Invalid input: /, '')}`;
}

const searchUrl = (location: string, when?: string) =>
  `/api/events/search?location=${encodeURIComponent(location)}${when ? `&when=${encodeURIComponent(when)}` : ''}`;

function guide() {
  return {
    name: 'EventFeed',
    purpose:
      'Tells travel planners what is on in a destination while a traveller is there: festivals, concerts, markets and wildlife seasons. Currently covers Hermanus, Western Cape, South Africa.',
    status: 'Local prototype. No authentication, runs on 127.0.0.1 only. Data is hand-curated and every event lists its source.',
    howToUse: [
      '1. Search: GET /api/events/search?location=Hermanus to list everything in a place.',
      '2. Narrow by dates with when=, e.g. when=August 2027, when=2027-08-15, when=this Saturday, when=1 June 2027 to 15 June 2027.',
      '3. Narrow by interests with interests=, comma-separated, e.g. interests=family-friendly,music. Events must have all listed interests. Each result\'s categories field shows the tags in use.',
      '4. Read each result\'s whenText (when it happens, in words), datesConfirmed, whatToExpect (caveats), booking, missingInformation (what is not known yet) and source.',
      '5. Add an event: POST /api/events with a JSON body (see uploadExamples). The response gives the new id and a verifyWith URL.',
      '6. Verify an upload: call the verifyWith URL and look for your event\'s id in results.',
    ],
    endpoints: SUPPORTED,
    eventTypes: {
      dated: 'A one-off event or a run of dates (startDate, optional endDate).',
      seasonal: 'A natural season by month that repeats every year, e.g. whale season June to November.',
      recurring: 'Repeats weekly on given days (frequency "weekly", daysOfWeek) or every year in given months (frequency "annual", months).',
    },
    importantCaveats: [
      'Seasonal wildlife events mean the animals are commonly present in those months. Sightings on any specific day are not guaranteed. Pass this on to travellers.',
      'If datesConfirmed is false, the dates are typical or expected but the organiser has not confirmed them.',
      'Season words like "summer" are not accepted for when=. Hermanus is in the southern hemisphere, so give months instead.',
      'Duplicate uploads (same name ignoring case, same source.url ignoring a trailing slash) are rejected with 409 and existingId.',
      'Relative dates without a day (e.g. "in 6 months") search the whole month they land in. query.interpreted.assumptions always says how when= was read.',
      'Not supported yet: update, delete, fetch-by-id, listing without a location, and limit/paging. To check an event you added, call the verifyWith URL from the upload response and find its id in results. Uploads are permanent, so do not upload test data you do not want kept.',
      'Categories are free text. Reuse existing tags (see the categories field in search results) so filters keep working.',
    ],
    uploadExamples,
    openapi: '/openapi.json',
  };
}

export function createApp({ db, now = () => new Date() }: { db: Db; now?: () => Date }) {
  const app = express();
  app.use(express.json());

  app.get('/', (_req, res) => res.redirect('/api'));
  app.get('/api', (_req, res) => res.json(guide()));
  app.get('/openapi.json', (_req, res) => res.json(openapi));

  app.get('/api/events/search', (req, res) => {
    const original = { location: req.query.location, when: req.query.when, interests: req.query.interests };
    const location = typeof req.query.location === 'string' ? req.query.location.trim() : '';
    const when = typeof req.query.when === 'string' ? req.query.when.trim() : '';
    // Accept both interests=a,b and interests=a&interests=b
    const interests = [req.query.interests].flat()
      .filter((v): v is string => typeof v === 'string')
      .flatMap((v) => v.split(','))
      .map((s) => s.trim().toLowerCase().replace(/[\s_]+/g, '-'))
      .filter(Boolean);
    const warnings = Object.keys(req.query)
      .filter((k) => !['location', 'when', 'interests'].includes(k))
      .map((k) => `Ignored unsupported parameter "${k}". Supported: location, when, interests.`);
    const all = db.all();
    const towns = [...new Set(all.map((e) => e.location.town))];

    if (!location) {
      return fail(res, 400, 'location is required. Tell me which town or region to search.', towns.map((t) => searchUrl(t)), original);
    }

    let range = null;
    let assumptions: string[] = [];
    if (when) {
      const parsed = parseWhen(when, now());
      if (!parsed.ok) return fail(res, 400, parsed.message, parsed.suggestions.map((s) => searchUrl(location, s)), original);
      range = parsed.range;
      assumptions = parsed.assumptions;
    }

    const q = location.toLowerCase();
    const inPlace = (e: StoredEvent) =>
      [e.location.town, e.location.region].some((p) => p.toLowerCase().includes(q) || q.includes(p.toLowerCase()));

    const placeMatches = all.filter(inPlace);
    const results = [];
    let inDates = 0;
    for (const e of placeMatches) {
      const reasons = [`In ${e.location.town}, ${e.location.region}`];
      if (range) {
        const why = matchWhen(e.temporal, range);
        if (!why) continue;
        reasons.push(why);
      }
      inDates++;
      const missing = interests.filter((i) => !e.categories.includes(i));
      if (missing.length) continue;
      if (interests.length) reasons.push(`Tagged ${interests.join(', ')}`);
      results.push(present(e, reasons));
    }

    const datePart = range ? ` between ${range.start} and ${range.end}` : '';
    const interestPart = interests.length ? ` matching ${interests.join(', ')}` : '';
    const body: any = {
      query: {
        original,
        interpreted: {
          location,
          matchedPlaces: [...new Set(placeMatches.map((e) => `${e.location.town}, ${e.location.region}`))],
          dateRange: range, interests, assumptions,
        },
      },
      // Notes go in the summary too, because agents read the summary first.
      summary: [`${results.length} event(s) in ${location}${datePart}${interestPart}.`, ...assumptions, ...warnings].join(' '),
      ...(warnings.length ? { warnings } : {}),
      results,
    };

    if (!results.length) {
      const suggestions: string[] = [];
      if (!placeMatches.length) {
        body.explanation = `No events are stored for "${location}". Places with events: ${towns.join(', ') || 'none yet'}.`;
        suggestions.push(...towns.map((t) => searchUrl(t, when)));
      } else if (range && inDates === 0) {
        body.explanation = `There are ${placeMatches.length} event(s) in ${location}, but none fall${datePart}.`;
        suggestions.push('Widen the date range', searchUrl(location));
      } else {
        const used = [...new Set(placeMatches.flatMap((e) => e.categories))].sort();
        body.explanation = `${inDates} event(s) in ${location}${datePart}, but none match all of: ${interests.join(', ')}. Interests used in ${location}: ${used.join(', ')}.`;
        suggestions.push('Remove or reduce the interests filter', searchUrl(location, when));
      }
      body.suggestions = suggestions;
    }
    res.json(body);
  });

  app.post('/api/events', (req, res) => {
    if (!req.is('application/json')) {
      return fail(res, 415, 'The body must be JSON. Set the header Content-Type: application/json.', [
        'curl: -H "Content-Type: application/json"',
        'PowerShell: Invoke-RestMethod -Method Post -ContentType application/json -Body ($event | ConvertTo-Json -Depth 5)',
      ]);
    }
    if (Array.isArray(req.body)) {
      return fail(res, 400, 'Send one event per request, as a JSON object, not an array.', ['POST each event separately'], '[array]');
    }
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => plainIssue(i, req.body));
      const t = req.body?.temporal;
      const exampleKey = t?.type === 'seasonal' ? 'seasonal'
        : t?.type === 'recurring' ? (t.frequency === 'annual' ? 'recurringAnnual' : 'recurringWeekly') : 'dated';
      res.status(400).json({
        error: {
          message: `The event was not saved. Problems: ${problems.join('; ')}`,
          problems,
          suggestions: ['Fix the fields listed in problems and send again', `See GET /api uploadExamples for one example per event type`],
          validExample: uploadExamples[exampleKey],
        },
      });
      return;
    }
    const existing = db.findDuplicate(parsed.data);
    if (existing) {
      const et = existing.temporal;
      res.status(409).json({
        error: {
          message: `This event already exists (id ${existing.id}). It was not created again. Use search to view it.`,
          suggestions: [searchUrl(existing.location.town, et.type === 'dated' ? et.startDate : undefined)],
        },
        existingId: existing.id,
      });
      return;
    }
    const saved = db.insert(parsed.data);
    const t = saved.temporal;
    const verifyWith = searchUrl(saved.location.town, t.type === 'dated' ? t.startDate : undefined);
    const { matchReasons, ...event } = present(saved);
    res.status(201).json({
      message: `Saved "${saved.name}" with id ${saved.id}. Call verifyWith to see it in search results.`,
      id: saved.id,
      verifyWith,
      event,
    });
  });

  // Known paths with unsupported methods
  app.all(['/api', '/openapi.json', '/api/events', '/api/events/search'], (req, res) => {
    fail(res, 405, `${req.method} ${req.path} is not supported.`, SUPPORTED);
  });

  app.all('/api/events/:id', (req, res) => {
    fail(res, 405, `${req.method} /api/events/{id} is not supported yet (no fetch, update or delete by id).`, [
      'To check an event, search for it: GET /api/events/search?location=<town> and find its id in results',
      ...SUPPORTED,
    ]);
  });

  app.use((req, res) => {
    fail(res, 404, `There is nothing at ${req.method} ${req.path}.`, SUPPORTED);
  });

  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err.type === 'entity.parse.failed') {
      return fail(res, 400, 'The request body is not valid JSON.', ['Send Content-Type: application/json with a valid JSON object', 'See GET /api for examples']);
    }
    console.error(err);
    fail(res, 500, 'Something went wrong on the server.', ['Try again', 'See GET /api for usage']);
  });

  return app;
}
