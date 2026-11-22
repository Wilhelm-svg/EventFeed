// Canonical value types produced by the platform. Agents send raw values; normalize.ts turns them into these.

export type Weekday = 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';

export type Temporal =
  | { type: 'dated'; startDate: string; endDate?: string; startTime?: string; endTime?: string; timezone: string; startUtc?: string }
  | { type: 'seasonal'; startMonth: number; endMonth: number; peakMonths?: number[]; timezone: string }
  | {
      type: 'recurring';
      frequency: 'weekly' | 'annual';
      daysOfWeek?: Weekday[];
      months?: number[];
      startTime?: string;
      endTime?: string;
      typicalDates?: string;
      timezone: string;
    };

export type Money = { amountMinor: number; currency: string; qualifier: 'exact' | 'from' };

export type RecordType = 'event' | 'property';

/** Thrown by a field normaliser when a raw value can't be turned into a canonical value. */
export class FieldError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
