// Platform reference data loaded into a fresh database. Agents grow the glossary through propose_glossary_change.

export const GLOSSARY_DOMAINS = {
  interest: 'Traveller interest tags used on events and properties (the interests= filter).',
  'property-type': 'Kinds of accommodation.',
  'rate-basis': 'What a quoted accommodation rate covers.',
  'meal-plan': 'Meals included in an accommodation rate.',
} as const;
export type GlossaryDomain = keyof typeof GLOSSARY_DOMAINS;

type Seed = { term: string; label: string; definition: string; domain: GlossaryDomain; synonyms: string[] };
const t = (domain: GlossaryDomain, term: string, label: string, definition: string, synonyms: string[] = []): Seed => ({ term, label, definition, domain, synonyms });

export const SEED_GLOSSARY: Seed[] = [
  t('interest', 'wildlife', 'Wildlife', 'Seeing wild animals, birds or marine life in their natural habitat.', ['animals', 'wildlife viewing']),
  t('interest', 'whale-watching', 'Whale watching', 'Seeing whales from shore or by boat.', ['whales', 'whale spotting']),
  t('interest', 'nature', 'Nature', 'Landscapes, plants, reserves and natural scenery.', ['scenery', 'fynbos']),
  t('interest', 'outdoors', 'Outdoors', 'Activities that take place outside.', ['outdoor', 'open air', 'open-air']),
  t('interest', 'adventure', 'Adventure', 'Physically active or thrill-seeking activities.', ['adrenaline', 'extreme']),
  t('interest', 'festival', 'Festival', 'A multi-part public celebration, usually over one or more days.', ['festivals', 'fest']),
  t('interest', 'family-friendly', 'Family-friendly', 'Suitable for and welcoming to children and families.', ['kid friendly', 'kids friendly', 'child friendly', 'children welcome', 'families']),
  t('interest', 'pet-friendly', 'Pet-friendly', 'Pets, usually dogs, are welcome.', ['dog friendly', 'pets welcome', 'pets allowed']),
  t('interest', 'music', 'Music', 'Live or recorded music is a main part of the experience.', ['live music']),
  t('interest', 'concert', 'Concert', 'A scheduled live music performance.', ['gig', 'recital']),
  t('interest', 'arts', 'Arts', 'Visual, performing or literary arts.', ['art', 'exhibition', 'theatre', 'theater']),
  t('interest', 'cultural', 'Cultural', 'Heritage, history, traditions or local culture.', ['culture', 'heritage', 'history']),
  t('interest', 'culinary', 'Culinary', 'Food is a main part of the experience.', ['food', 'gastronomy', 'food and wine', 'foodie']),
  t('interest', 'wine', 'Wine', 'Wine tasting, wineries or wine-focused experiences.', ['wine tasting', 'winery', 'wineries']),
  t('interest', 'market', 'Market', 'A gathering of stalls selling produce, crafts or goods.', ['markets', 'craft market', 'farmers market']),
  t('interest', 'sport', 'Sport', 'Spectator sport or sporting events.', ['sports', 'match', 'rugby', 'cricket']),
  t('property-type', 'lodge', 'Lodge', 'A hosted property in a natural setting, often with meals and activities.', ['game lodge', 'safari lodge']),
  t('property-type', 'hotel', 'Hotel', 'A serviced property with rooms and a front desk.', ['boutique hotel']),
  t('property-type', 'guesthouse', 'Guesthouse', 'A small hosted property with a few rooms.', ['guest house']),
  t('property-type', 'bed-and-breakfast', 'Bed and breakfast', 'A small hosted property where breakfast is the main meal offered.', ['b&b', 'bnb', 'b and b']),
  t('property-type', 'self-catering', 'Self-catering', 'Accommodation where guests prepare their own meals.', ['self catering', 'holiday home', 'cottage']),
  t('property-type', 'villa', 'Villa', 'A private house rented as a whole.', ['private villa', 'exclusive use house']),
  t('property-type', 'camp', 'Camp', 'Tented or semi-permanent accommodation.', ['tented camp', 'glamping']),
  t('rate-basis', 'per-room-night', 'Per room per night', 'The amount is for one room for one night, regardless of occupants within its capacity.', ['per room', 'per room per night', 'prpn', 'per unit per night']),
  t('rate-basis', 'per-person-night', 'Per person per night', 'The amount is for one person for one night.', ['pp', 'per person', 'pppn', 'pp sharing', 'per person sharing', 'pps', 'per person per night']),
  t('rate-basis', 'per-stay', 'Per stay', 'The amount covers the whole stay.', ['total', 'per stay', 'package']),
  t('meal-plan', 'room-only', 'Room only', 'No meals included.', ['ro', 'no meals']),
  t('meal-plan', 'breakfast', 'Breakfast included', 'Breakfast is included.', ['b&b', 'bb', 'bed and breakfast', 'breakfast included']),
  t('meal-plan', 'half-board', 'Half board', 'Breakfast and dinner are included.', ['hb', 'dbb', 'dinner bed and breakfast']),
  t('meal-plan', 'full-board', 'Full board', 'Breakfast, lunch and dinner are included.', ['fb', 'all meals']),
  t('meal-plan', 'all-inclusive', 'All inclusive', 'Meals plus drinks and usually activities are included.', ['ai', 'fully inclusive']),
];

/** Domain → source tier. 1 official, 2 tourism body, 3 listing/third party, 4 unknown. */
export const SEED_SOURCES = [
  { domain: 'hermanusfynarts.co.za', tier: 1, kind: 'official', note: 'Hermanus FynArts organiser' },
  { domain: 'hermanuscountrymarket.co.za', tier: 1, kind: 'official', note: 'Hermanus Country Market organiser' },
  { domain: 'hermanus-tourism.co.za', tier: 2, kind: 'tourism-body', note: 'Hermanus tourism' },
  { domain: 'whalehermanus.com', tier: 3, kind: 'listing', note: 'Local whale-watching operator, not the festival organiser' },
  { domain: 'sa-venues.com', tier: 3, kind: 'listing', note: 'Listing site; hours seen out of date in 2026' },
  { domain: 'capetownetc.com', tier: 3, kind: 'listing', note: 'News and listings' },
  { domain: 'whalefestival.co.za', tier: 4, kind: 'other', note: 'Domain no longer belongs to the festival (checked 2026-11-22)' },
];

/** Known places: lowercase town → region, country, timezone. Unknown towns are accepted and flagged. */
export const GAZETTEER: Record<string, { town: string; region: string; country: string; timezone: string }> = {
  hermanus: { town: 'Hermanus', region: 'Western Cape', country: 'South Africa', timezone: 'Africa/Johannesburg' },
  'cape town': { town: 'Cape Town', region: 'Western Cape', country: 'South Africa', timezone: 'Africa/Johannesburg' },
  stanford: { town: 'Stanford', region: 'Western Cape', country: 'South Africa', timezone: 'Africa/Johannesburg' },
  gansbaai: { town: 'Gansbaai', region: 'Western Cape', country: 'South Africa', timezone: 'Africa/Johannesburg' },
  johannesburg: { town: 'Johannesburg', region: 'Gauteng', country: 'South Africa', timezone: 'Africa/Johannesburg' },
};
export const DEFAULT_TIMEZONE = 'Africa/Johannesburg';

/** Starter knowledge packets: lessons from the prototype research run. */
export const SEED_PACKETS = [
  {
    slug: 'official-sources-first',
    name: 'Prefer official sources over listing sites',
    description: 'Which sources to trust for event and property facts, and why listing sites are only for corroboration.',
    categories: ['source-discovery', 'conflict-resolution'],
    steps: [
      'Search for the organiser\'s or property\'s own website first, then the official tourism body, and only then listing sites.',
      'Check that the domain still belongs to the organiser: a festival\'s old domain can be taken over by unrelated content.',
      'Use listing sites only to corroborate. In the prototype, two listing sites showed out-of-date market hours (08:00-12:00) while the official site said 09:00-14:00.',
      'Submit the official source even when a listing site is easier to read; the platform ranks evidence by source tier.',
    ],
    limitations: ['Some small events have no official site; then a tourism body page is the best available source.'],
    evidence: [],
  },
  {
    slug: 'quoting-evidence-excerpts',
    name: 'Quoting excerpts that pass the evidence check',
    description: 'How to pick an excerpt so submit_findings accepts it: exact words from the fetched page, short and specific.',
    categories: ['extraction'],
    steps: [
      'Call fetch_source with find="<words you expect>" to see the exact wording on the page.',
      'Copy a short exact phrase (5-15 words) that contains the fact itself, such as the dates or the price.',
      'Case, curly quotes, dashes and extra spaces are ignored by the check, but words and numbers must match exactly.',
      'Do not paraphrase, translate or combine phrases from different parts of the page into one excerpt.',
    ],
    limitations: ['Pages that need JavaScript may have no readable text; fetch_source then returns SOURCE_EMPTY.', 'PDF documents cannot be used as evidence yet.'],
    evidence: [],
  },
];
