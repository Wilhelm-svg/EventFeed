// Uploads data/events.json through the API (never directly into the database). Safe to run twice.
import { readFileSync } from 'node:fs';

const BASE = process.env.EVENTFEED_URL ?? 'http://127.0.0.1:3000';
const events = JSON.parse(readFileSync('data/events.json', 'utf8'));

for (const e of events) {
  const res = await fetch(`${BASE}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(e),
  });
  const body: any = await res.json();
  if (res.status === 201) console.log(`created  ${e.name} (id ${body.id})`);
  else if (res.status === 409) console.log(`skipped  ${e.name} (already exists, id ${body.existingId})`);
  else console.log(`FAILED   ${e.name}: ${res.status} ${body.error?.message}`);
}
