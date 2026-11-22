import { exampleEvent } from './schema.js';

const errorFields = {
  message: { type: 'string', description: 'What went wrong, in plain language' },
  suggestions: { type: 'array', items: { type: 'string' }, description: 'How to fix it (often ready-to-call URLs)' },
};

const errorResponse = (description: string, extraErrorFields = {}, extraTopLevel = {}) => ({
  description,
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { error: { type: 'object', properties: { ...errorFields, ...extraErrorFields } }, ...extraTopLevel },
      },
    },
  },
});

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'EventFeed',
    version: '0.1.0',
    description:
      'What is on in a destination while a traveller is there: festivals, concerts, markets and wildlife seasons. Local prototype covering Hermanus, South Africa. Start with GET /api for a plain-language guide.',
  },
  servers: [{ url: 'http://127.0.0.1:3000' }],
  paths: {
    '/api': {
      get: { summary: 'Plain-language guide to this API', responses: { 200: { description: 'Guide' } } },
    },
    '/api/events/search': {
      get: {
        summary: 'Find events in a place, optionally during given dates and matching interests',
        parameters: [
          { name: 'location', in: 'query', required: true, schema: { type: 'string' }, example: 'Hermanus', description: 'Town or region name' },
          {
            name: 'when', in: 'query', required: false, schema: { type: 'string' }, example: 'August 2027',
            description: 'Natural-language date or range, e.g. "August 2027", "2027-08-15", "this Saturday", "1 June 2027 to 15 June 2027". Omit to get all events. Season words like "summer" are rejected as ambiguous.',
          },
          {
            name: 'interests', in: 'query', required: false, schema: { type: 'string' }, example: 'family-friendly,music',
            description: 'Comma-separated categories. An event must have all of them.',
          },
        ],
        responses: {
          200: { description: 'Matching events with the interpreted query, a summary, and for each event whenText, missingInformation and matchReasons' },
          400: errorResponse('Missing location or a date that could not be understood', { receivedInput: { description: 'The query you sent' } }),
        },
      },
    },
    '/api/events': {
      post: {
        summary: 'Add one event',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'description', 'location', 'temporal', 'datesConfirmed', 'categories', 'source'],
                properties: {
                  name: { type: 'string' },
                  description: { type: 'string' },
                  location: {
                    type: 'object',
                    required: ['town', 'region', 'country'],
                    properties: { town: { type: 'string' }, region: { type: 'string' }, country: { type: 'string' }, venue: { type: 'string' }, address: { type: 'string' } },
                  },
                  temporal: {
                    description: 'One of three shapes, chosen by "type"',
                    oneOf: [
                      {
                        title: 'dated: one-off or a run of dates',
                        type: 'object', required: ['type', 'startDate'],
                        properties: { type: { enum: ['dated'] }, startDate: { type: 'string', format: 'date' }, endDate: { type: 'string', format: 'date' }, startTime: { type: 'string', example: '19:00' } },
                      },
                      {
                        title: 'seasonal: natural season by month, every year',
                        type: 'object', required: ['type', 'startMonth', 'endMonth'],
                        properties: { type: { enum: ['seasonal'] }, startMonth: { type: 'integer', minimum: 1, maximum: 12 }, endMonth: { type: 'integer', minimum: 1, maximum: 12 }, peakMonths: { type: 'array', items: { type: 'integer' } } },
                      },
                      {
                        title: 'recurring: weekly (needs daysOfWeek) or annual (needs months)',
                        type: 'object', required: ['type', 'frequency'],
                        properties: {
                          type: { enum: ['recurring'] }, frequency: { enum: ['weekly', 'annual'] },
                          daysOfWeek: { type: 'array', items: { enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] } },
                          months: { type: 'array', items: { type: 'integer' } }, startTime: { type: 'string' }, endTime: { type: 'string' }, typicalDates: { type: 'string' },
                        },
                      },
                    ],
                  },
                  datesConfirmed: { type: 'boolean', description: 'false if the organiser has not confirmed the dates' },
                  categories: { type: 'array', items: { type: 'string' }, example: ['music', 'family-friendly'] },
                  booking: { type: 'object', properties: { required: { type: 'boolean' }, advice: { type: 'string' } } },
                  price: { type: 'string' },
                  whatToExpect: { type: 'string', description: 'Caveats, e.g. that wildlife sightings are not guaranteed' },
                  source: { type: 'object', required: ['url', 'checkedOn'], properties: { url: { type: 'string', format: 'uri' }, checkedOn: { type: 'string', format: 'date' } } },
                },
              },
              example: exampleEvent,
            },
          },
        },
        responses: {
          201: {
            description: 'Created. There is no fetch-by-id; call verifyWith and find the id in results.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    message: { type: 'string' },
                    id: { type: 'string' },
                    verifyWith: { type: 'string', description: 'Search URL whose results include the new event id' },
                    event: { type: 'object', description: 'The saved event with whenText and missingInformation' },
                  },
                },
              },
            },
          },
          400: errorResponse('Invalid event. Nothing was saved. Unknown fields are rejected.', {
            problems: { type: 'array', items: { type: 'string' }, description: 'One plain-language sentence per problem field' },
            validExample: { type: 'object', description: 'A valid body for the event type you attempted' },
          }),
          409: errorResponse(
            'Duplicate: an event with the same name (ignoring case and spaces) and source.url (ignoring a trailing slash) already exists. Nothing was saved.',
            {},
            { existingId: { type: 'string', description: 'id of the event that already exists' } },
          ),
          415: errorResponse('Body is not JSON: set Content-Type: application/json'),
        },
      },
    },
  },
};
