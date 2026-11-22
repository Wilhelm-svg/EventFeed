import type { StoredEvent } from './schema.js';
import { MONTHS, seasonMonths } from './match.js';

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const months = (ms: number[]) => ms.map((m) => MONTHS[m - 1]).join(', ');

function displayDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

/** Plain-language description of when the event happens. */
export function whenText(e: StoredEvent): string {
  const t = e.temporal;
  let text: string;
  if (t.type === 'dated') {
    text = t.endDate && t.endDate !== t.startDate ? `${displayDate(t.startDate)} to ${displayDate(t.endDate)}` : displayDate(t.startDate);
    if (t.startTime) text += `, starting ${t.startTime}`;
  } else if (t.type === 'seasonal') {
    const all = seasonMonths(t.startMonth, t.endMonth);
    text = `${MONTHS[t.startMonth - 1]} to ${MONTHS[t.endMonth - 1]} each year (${all.length} months)`;
    if (t.peakMonths?.length) text += `, peak ${months(t.peakMonths)}`;
  } else if (t.frequency === 'weekly') {
    text = `Every ${t.daysOfWeek!.map(cap).join(' and ')}`;
    if (t.startTime) text += `, ${t.startTime}${t.endTime ? `–${t.endTime}` : ''}`;
  } else {
    text = `Every year in ${months(t.months!)}`;
    if (t.typicalDates) text += `. ${t.typicalDates}`;
  }
  return e.datesConfirmed ? text : `${text} (dates not yet confirmed)`;
}

/** Optional details that are not known yet, so agents can tell the traveller what is uncertain. */
export function missingInformation(e: StoredEvent): string[] {
  const missing: string[] = [];
  if (!e.datesConfirmed) missing.push('confirmed dates');
  if (e.temporal.type === 'dated' && !e.temporal.startTime) missing.push('start time');
  if (!e.location.venue) missing.push('venue');
  if (!e.price) missing.push('price');
  if (e.booking.required === undefined) missing.push('whether booking is required');
  if (!e.booking.advice) missing.push('booking advice');
  return missing;
}

export function present(e: StoredEvent, matchReasons: string[] = []) {
  return {
    id: e.id,
    name: e.name,
    description: e.description,
    whenText: whenText(e),
    datesConfirmed: e.datesConfirmed,
    whatToExpect: e.whatToExpect ?? null,
    location: e.location,
    categories: e.categories,
    booking: e.booking,
    price: e.price ?? null,
    temporal: e.temporal,
    source: e.source,
    missingInformation: missingInformation(e),
    matchReasons,
  };
}
