import { z } from 'zod';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format, e.g. "2027-03-06"')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return isNaN(d.getTime()) ? !/^\d{4}-\d{2}-\d{2}$/.test(s) : d.toISOString().startsWith(s); // bad format is already reported by the regex
  }, 'is not a real calendar date');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a real 24-hour time in HH:MM format, e.g. "09:00"');
const month = z.number().int().min(1).max(12);
const weekday = z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);

const dated = z
  .object({
    type: z.literal('dated'),
    startDate: isoDate,
    endDate: isoDate.optional(),
    startTime: time.optional(),
  })
  .refine((d) => !d.endDate || d.endDate >= d.startDate, { message: 'must be on or after startDate', path: ['endDate'] });

const seasonal = z.object({
  type: z.literal('seasonal'),
  startMonth: month,
  endMonth: month,
  peakMonths: z.array(month).optional(),
});

const recurring = z
  .object({
    type: z.literal('recurring'),
    frequency: z.enum(['weekly', 'annual']),
    daysOfWeek: z.array(weekday).min(1).optional(),
    months: z.array(month).min(1).optional(),
    startTime: time.optional(),
    endTime: time.optional(),
    typicalDates: z.string().optional(),
  })
  .refine((r) => r.frequency !== 'weekly' || r.daysOfWeek, {
    message: 'is required for weekly events, e.g. ["saturday"]',
    path: ['daysOfWeek'],
  })
  .refine((r) => r.frequency !== 'annual' || r.months, {
    message: 'is required for annual events, e.g. [9, 10]',
    path: ['months'],
  });

export const temporalSchema = z.discriminatedUnion('type', [dated, seasonal, recurring], {
  error: 'must be "dated", "seasonal" or "recurring" (see GET /api uploadExamples)',
});

// strictObject: unknown top-level fields are rejected rather than silently dropped.
export const eventSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  location: z.object({
    town: z.string().trim().min(1),
    region: z.string().trim().min(1),
    country: z.string().trim().min(1),
    venue: z.string().optional(),
    address: z.string().optional(),
  }),
  temporal: temporalSchema,
  datesConfirmed: z.boolean(),
  categories: z.array(z.string().trim().toLowerCase()).min(1),
  booking: z.object({ required: z.boolean().optional(), advice: z.string().optional() }).default({}),
  price: z.string().optional(),
  whatToExpect: z.string().optional(),
  source: z.object({ url: z.url({ error: 'must be a full URL, e.g. "https://example.com/event"' }), checkedOn: isoDate }),
});

export type EventInput = z.infer<typeof eventSchema>;
export type Temporal = z.infer<typeof temporalSchema>;
export type StoredEvent = EventInput & { id: string; createdAt: string };

/** Normalised source URL used for duplicate detection: lowercase host, no trailing slash. */
export function normaliseUrl(u: string): string {
  const url = new URL(u);
  return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

export const exampleEvent: EventInput = {
  name: 'Example Jazz Evening',
  description: 'One-night jazz concert.',
  location: { town: 'Hermanus', region: 'Western Cape', country: 'South Africa', venue: 'Example Hall' },
  temporal: { type: 'dated', startDate: '2027-04-10', startTime: '19:00' },
  datesConfirmed: true,
  categories: ['music', 'concert'],
  booking: { required: true, advice: 'Buy tickets from the venue.' },
  source: { url: 'https://example.com/jazz', checkedOn: '2026-11-22' },
};

/** One valid upload body per temporal shape. */
export const uploadExamples: Record<string, EventInput> = {
  dated: exampleEvent,
  seasonal: {
    ...exampleEvent, name: 'Example Flower Season', description: 'Spring wildflowers in bloom on the mountain trails.',
    location: { ...exampleEvent.location, venue: 'Example Nature Reserve' },
    temporal: { type: 'seasonal', startMonth: 8, endMonth: 10, peakMonths: [9] }, categories: ['nature', 'outdoors'],
    booking: { required: false, advice: 'No booking needed.' }, whatToExpect: 'Blooms vary year to year and are not guaranteed on a given day.',
    source: { url: 'https://example.com/flowers', checkedOn: '2026-11-22' },
  },
  recurringWeekly: {
    ...exampleEvent, name: 'Example Sunday Market', description: 'Weekly craft and food market.',
    location: { ...exampleEvent.location, venue: 'Example Village Green' },
    temporal: { type: 'recurring', frequency: 'weekly', daysOfWeek: ['sunday'], startTime: '09:00', endTime: '13:00' },
    categories: ['market', 'family-friendly'], booking: { required: false, advice: 'Walk in.' },
    source: { url: 'https://example.com/sunday-market', checkedOn: '2026-11-22' },
  },
  recurringAnnual: {
    ...exampleEvent, name: 'Example Annual Fair', description: 'Yearly agricultural fair.',
    location: { ...exampleEvent.location, venue: 'Example Showgrounds' },
    temporal: { type: 'recurring', frequency: 'annual', months: [3], typicalDates: 'Usually the first weekend of March.' },
    datesConfirmed: false, categories: ['festival', 'family-friendly'], booking: {},
    source: { url: 'https://example.com/annual-fair', checkedOn: '2026-11-22' },
  },
};
