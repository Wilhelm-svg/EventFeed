import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { normaliseUrl, type EventInput, type StoredEvent } from './schema.js';

export type Db = ReturnType<typeof createDb>;

const JSON_COLUMNS = ['location', 'temporal', 'categories', 'booking', 'source'] as const;

export function createDb(path: string) {
  const sql = new Database(path);
  sql.exec(`CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    location TEXT NOT NULL,
    temporal TEXT NOT NULL,
    datesConfirmed INTEGER NOT NULL,
    categories TEXT NOT NULL,
    booking TEXT NOT NULL,
    price TEXT,
    whatToExpect TEXT,
    source TEXT NOT NULL,
    createdAt TEXT NOT NULL
  )`);

  const toEvent = (row: any): StoredEvent => {
    const e: any = { ...row, datesConfirmed: row.datesConfirmed === 1 };
    for (const c of JSON_COLUMNS) e[c] = JSON.parse(row[c]);
    if (e.price === null) delete e.price;
    if (e.whatToExpect === null) delete e.whatToExpect;
    return e;
  };

  return {
    all(): StoredEvent[] {
      return sql.prepare('SELECT * FROM events ORDER BY rowid').all().map(toEvent);
    },

    findDuplicate(e: EventInput): StoredEvent | undefined {
      const name = e.name.trim().toLowerCase();
      const url = normaliseUrl(e.source.url);
      return this.all().find((x) => x.name.trim().toLowerCase() === name && normaliseUrl(x.source.url) === url);
    },

    insert(e: EventInput): StoredEvent {
      const row = {
        id: randomUUID(),
        name: e.name,
        description: e.description,
        location: JSON.stringify(e.location),
        temporal: JSON.stringify(e.temporal),
        datesConfirmed: e.datesConfirmed ? 1 : 0,
        categories: JSON.stringify(e.categories),
        booking: JSON.stringify(e.booking),
        price: e.price ?? null,
        whatToExpect: e.whatToExpect ?? null,
        source: JSON.stringify(e.source),
        createdAt: new Date().toISOString(),
      };
      sql
        .prepare(
          `INSERT INTO events VALUES (@id, @name, @description, @location, @temporal, @datesConfirmed,
           @categories, @booking, @price, @whatToExpect, @source, @createdAt)`,
        )
        .run(row);
      return toEvent(row);
    },
  };
}
