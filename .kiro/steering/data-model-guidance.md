# Data Model Guidance

Guidelines for designing the EventFeed data model based on the problem domain and Magic Safari principles.

## Core Problem

The EventFeed needs to represent diverse event types with varying temporal characteristics, while being queryable by travel agents planning trips 6-18 months in advance.

## Event Type Taxonomy

### 1. Point-in-Time Events
**Examples**: Concert on Dec 12, rugby match on April 17, weekly Saturday market

**Characteristics**:
- Specific date and time
- Single occurrence or recurring pattern
- Clear start and end time

**Data requirements**:
- Date/time
- Duration
- Recurrence rule (if applicable)
- Venue/location

### 2. Bounded Running Events
**Examples**: Theatre show with 81 performances, year-long exhibition

**Characteristics**:
- Multiple dates/sessions
- Defined start and end period
- May have daily/weekly schedule variations

**Data requirements**:
- Overall date range
- Schedule/performance times
- Availability pattern
- Booking windows

### 3. Future Events
**Examples**: Festival in June 2027 (announced months ahead)

**Characteristics**:
- Long lead time
- May have tentative dates
- Details emerge over time

**Data requirements**:
- Announcement date
- Confirmed vs tentative dates
- Detail completeness indicator
- Update history

### 4. Seasonal Events
**Examples**: Whale watching June-November, migration patterns

**Characteristics**:
- Date range without specific daily schedule
- Natural phenomena
- Year-over-year patterns
- Weather/condition dependent

**Data requirements**:
- Season start/end (month-based)
- Peak period indicators
- Reliability/predictability score
- Historical patterns

### 5. Recurring Events
**Examples**: Weekly markets, monthly concerts, annual festivals

**Characteristics**:
- Predictable pattern
- May span years
- Pattern may have exceptions

**Data requirements**:
- Recurrence rule (RRULE or similar)
- Exception dates
- Pattern confidence
- Next occurrence calculation

## Key Design Principles

### Principle 1: Temporal Flexibility Over Rigid Schema

**Rule**: Support diverse temporal representations without forcing all events into a single temporal model.

**Accept**: More complex querying logic, potential for temporal representation inconsistencies.

**Benefit**: Can accurately represent natural phenomena (seasons) alongside scheduled events without data distortion.

### Principle 2: Agent-Friendly Query Interface

**Rule**: Design APIs that agents can easily understand and use for natural language queries like "What's happening in Hermanus in August 2027?"

**Accept**: May need to duplicate data or pre-compute common queries for performance.

**Benefit**: Agents can reliably answer user questions without complex query construction.

### Principle 3: Progressive Detail Enrichment

**Rule**: Allow events to be added with minimal data and enriched over time as more information becomes available.

**Accept**: Inconsistent detail levels across events, need for completeness indicators.

**Benefit**: Can capture future events early and refine them, matching how real-world event information emerges.

### Principle 4: Traveler-Centric Categorization

**Rule**: Tag events with traveler interest categories (family-friendly, adventure, cultural, wildlife, culinary, etc.) not just event type.

**Accept**: Subjective categorization, need for multiple tags, ongoing curation effort.

**Benefit**: Travel agents can filter by traveler profile without understanding event taxonomy.

### Principle 5: Booking Horizon Awareness

**Rule**: Track when events need to be booked relative to occurrence (book 6 months ahead vs day-of tickets).

**Accept**: Additional complexity in event metadata, need to maintain booking window information.

**Benefit**: Agents can alert planners about booking deadlines matching the 6-18 month planning window.

## Data Model Skeleton

```typescript
interface Event {
  id: string;
  name: string;
  description: string;
  location: Location;
  
  // Temporal representation (flexible based on event type)
  temporal: PointInTime | BoundedPeriod | Season | RecurringPattern;
  
  // Traveler-centric metadata
  categories: Category[];  // e.g., "family-friendly", "wildlife", "cultural"
  ageAppropriate: AgeRange;
  durationTypical: Duration;
  
  // Booking metadata
  bookingHorizon: BookingWindow;  // e.g., "6 months advance", "walk-in"
  bookingRequired: boolean;
  capacityLimited: boolean;
  
  // Detail tracking
  detailCompleteness: number;  // 0-1 score
  lastUpdated: Date;
  dataSource: string;
  
  // Rich content
  images: Image[];
  externalLinks: Link[];
}

interface Location {
  name: string;
  coordinates: [number, number];
  region: string;  // e.g., "Hermanus", "Western Cape"
  venue?: string;
}

// Temporal type examples
type PointInTime = {
  type: 'point';
  dateTime: Date;
  duration: Duration;
  timezone: string;
};

type Season = {
  type: 'season';
  startMonth: number;
  endMonth: number;
  peakMonths?: number[];
  reliability: number;  // 0-1 score
  notes?: string;
};

// ... other temporal types
```

## Agent Query Patterns to Support

1. **"What's happening in [location] during [date range]?"**
   - Filter by location and temporal overlap

2. **"Show me family-friendly events in [location] this summer"**
   - Filter by location, season, and category

3. **"What should we book now for a trip in [future date]?"**
   - Filter by booking horizon and date

4. **"Are whales visible in Hermanus in September?"**
   - Seasonal event lookup with reliability scoring

5. **"What weekend events are there?"**
   - Recurring pattern matching for Saturdays/Sundays

## Data Quality Principles

From Karpathy methodologies:

1. **Start with clean, high-quality seed data** for Hermanus rather than trying to ingest everything
2. **Manual curation beats automated mess** - verify first batch by hand
3. **Build validation tools** before building ingestion pipelines
4. **Measure completeness** - know what's missing and track it
5. **Version your data** - track changes and understand drift over time

## Open Decisions

### Decision 1: Single Table vs Event Type Tables?

**Question**: Should we use one events table with flexible schema, or separate tables per event type?

**Recommendation**: Single table with type-based JSON field for temporal representation.

**Example under Single Table**:
```json
{
  "id": "evt_123",
  "name": "Whale Season",
  "temporal": {
    "type": "season",
    "startMonth": 6,
    "endMonth": 11
  }
}
```

**Example under Type Tables**:
```sql
-- events table (shared fields)
-- seasonal_events table (season-specific fields)
-- point_events table (date-specific fields)
```

**Tradeoff**: Single table = simpler queries, harder schema evolution. Type tables = cleaner schema, more complex joins.

### Decision 2: Real-time vs Cached Query Layer?

**Question**: Should agent queries hit the database directly or go through a cached/pre-computed query layer?

**Recommendation**: Start with direct queries, add caching when we measure actual latency issues.

**Reasoning**: Premature optimization. We don't know query patterns yet. Build simple, measure, then optimize the bottleneck.

## Validation Strategy

Work through these cases by hand before building:

1. **Case: Whale Season Query**
   - Input: "Are whales in Hermanus in August?"
   - Expected: Returns seasonal event with reliability score, notes about peak months
   
2. **Case: Festival with Long Lead Time**
   - Input: Event announced 18 months ahead with tentative dates
   - Expected: Event appears in results with "tentative" indicator, detail completeness < 1.0

3. **Case: Recurring Market**
   - Input: "Saturday events in Hermanus"
   - Expected: Returns Hermanus Country Market with recurrence pattern

4. **Case: Booking Deadline Alert**
   - Input: Agent planning September 2027 trip in March 2027
   - Expected: Surfaces events requiring booking in advance with time-to-deadline

5. **Case: Multi-Category Filtering**
   - Input: "Family-friendly cultural events in June"
   - Expected: Returns events tagged with both categories, filtered by date
