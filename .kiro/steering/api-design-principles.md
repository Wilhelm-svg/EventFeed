# API Design Principles

Guidelines for building agent-friendly APIs that enable natural language interaction with the EventFeed.

## Core Philosophy

The API should be designed for AI agents (Claude, GPT, etc.) to consume, not just humans. This means:

1. **Descriptive over terse**: Use clear field names and verbose documentation
2. **Forgiving input**: Accept natural language dates, flexible parameters
3. **Rich responses**: Return enough context that agents don't need follow-up calls
4. **Self-documenting**: API responses should explain themselves

## Design Principles

### Principle 1: Natural Language Date Handling

**Rule**: Accept dates in multiple formats that match how agents and humans think about time.

**Implementation**:
```typescript
// Accept all of these:
"August 2027"
"2027-08-15"
"June to November"
"next summer"
"in 6 months"
```

**Accept**: More complex parsing logic, potential ambiguity requiring clarification.

**Benefit**: Agents can pass through user intent without date format translation.

### Principle 2: Query by Intent, Not Schema

**Rule**: API endpoints should match user questions, not database structure.

**Good**: `GET /events/in-location?place=Hermanus&when=August 2027&interests=family-friendly`

**Bad**: `GET /events?location_id=123&start_date=2027-08-01&end_date=2027-08-31&category_ids=5,7,12`

**Accept**: May need to build multiple query paths to same underlying data.

**Benefit**: Agents can construct queries from natural language without lookup tables.

### Principle 3: Return Context, Not Just Data

**Rule**: Include enough metadata that agents understand what they're looking at without domain expertise.

**Example Response**:
```json
{
  "event": {
    "name": "Southern Right Whale Season",
    "description": "...",
    "temporal": {
      "type": "seasonal",
      "period": "June - November",
      "peak": "September - October",
      "reliability": 0.95,
      "explanation": "Whales are present 95% of days during this period based on 10 years of data"
    },
    "bookingAdvice": {
      "required": false,
      "recommended": "1 week in advance for boat tours",
      "note": "Shore-based viewing requires no booking"
    }
  }
}
```

**Accept**: Larger response payloads, some redundancy in data.

**Benefit**: Agents can give complete answers without inferring meaning from codes or IDs.

### Principle 4: Graceful Degradation for Incomplete Data

**Rule**: Return events even when some fields are missing, with explicit indicators of what's incomplete.

**Example**:
```json
{
  "event": {
    "name": "FynArts Festival 2027",
    "dates": {
      "confirmed": false,
      "tentative": "June 2027",
      "lastUpdated": "2026-11-15"
    },
    "completeness": {
      "score": 0.4,
      "missing": ["exact dates", "venue details", "ticket pricing"],
      "available": ["event name", "general timeframe", "event type"]
    }
  }
}
```

**Accept**: Complex response structure, need to track completeness.

**Benefit**: Agents can inform users about upcoming events while being transparent about uncertainty.

### Principle 5: Agent-Friendly Error Messages

**Rule**: Errors should explain what went wrong and suggest fixes in plain language.

**Bad**:
```json
{
  "error": "INVALID_DATE_FORMAT",
  "code": 400
}
```

**Good**:
```json
{
  "error": {
    "message": "I couldn't understand the date 'next summer'. Try using a specific month like 'June 2027' or a date like '2027-06-15'.",
    "suggestions": [
      "Use a month and year: 'August 2027'",
      "Use a specific date: '2027-08-15'",
      "Use a season with a year: 'summer 2027'"
    ],
    "receivedInput": "next summer"
  }
}
```

**Accept**: Verbose error responses.

**Benefit**: Agents can self-correct or ask clarifying questions without developer intervention.

## Core API Endpoints

### 1. Query Events

**Purpose**: Main search endpoint for agents to find events.

```
GET /api/events/search
```

**Parameters**:
- `location` (string, required): Place name (e.g., "Hermanus", "Western Cape")
- `when` (string, optional): Natural language date or range
- `interests` (array, optional): Interest categories (e.g., ["family-friendly", "wildlife"])
- `bookingHorizon` (string, optional): When trip is being planned for (affects booking deadline filtering)
- `limit` (number, optional): Max results (default: 50)

**Response**:
```json
{
  "query": {
    "interpreted": {
      "location": "Hermanus, Western Cape, South Africa",
      "dateRange": {
        "start": "2027-08-01",
        "end": "2027-08-31"
      },
      "interests": ["family-friendly"]
    },
    "original": {
      "location": "Hermanus",
      "when": "August 2027",
      "interests": ["family-friendly"]
    }
  },
  "results": [
    {
      "event": { /* full event object */ },
      "relevanceScore": 0.95,
      "relevanceReasons": [
        "Matches location: Hermanus",
        "Within requested timeframe",
        "Tagged as family-friendly"
      ]
    }
  ],
  "metadata": {
    "totalResults": 12,
    "queryTime": "45ms"
  }
}
```

### 2. Get Event Details

**Purpose**: Full details on a specific event.

```
GET /api/events/{eventId}
```

**Response**: Complete event object with all available fields.

### 3. Get Seasonal Patterns

**Purpose**: Specialized query for natural seasonal phenomena.

```
GET /api/seasonal/{location}
```

**Parameters**:
- `location` (string, required)
- `month` (number, optional): Filter to specific month
- `type` (string, optional): Type of seasonal event (e.g., "wildlife", "weather", "harvest")

**Example**: `GET /api/seasonal/Hermanus?month=8`

### 4. Booking Recommendations

**Purpose**: What needs to be booked now for a future trip?

```
GET /api/booking/recommendations
```

**Parameters**:
- `location` (string, required)
- `travelDates` (string, required): When the trip will occur
- `currentDate` (string, optional): When planning is happening (defaults to now)

**Response**: Events requiring booking with urgency indicators.

## Agent Integration Patterns

### Pattern 1: Natural Language Query Translation

**Agent Task**: User asks "What's happening in Hermanus when we're there in August?"

**Agent Flow**:
1. Extract: location="Hermanus", timeframe="August" (infer current year + future logic)
2. Call: `GET /api/events/search?location=Hermanus&when=August 2027`
3. Parse response, synthesize natural language answer

### Pattern 2: Multi-Turn Refinement

**Agent Task**: User asks follow-up to narrow results

**Agent Flow**:
1. User: "What's happening in Hermanus in August?"
2. Agent calls API, gets 50 results
3. User: "Only family-friendly things"
4. Agent calls API again with `interests=["family-friendly"]` filter
5. Agent presents refined results

### Pattern 3: Booking Timeline Awareness

**Agent Task**: Alert user about booking deadlines

**Agent Flow**:
1. User is planning trip for August 2027
2. Current date is February 2027
3. Agent calls `/api/booking/recommendations` with travel dates
4. API returns events requiring booking within next 2 weeks
5. Agent proactively mentions these to user

## API Response Standards

### Date Representation

Always include both machine-readable and human-readable formats:

```json
{
  "date": {
    "iso": "2027-08-15",
    "display": "August 15, 2027",
    "relative": "in 8 months"
  }
}
```

### Uncertainty Handling

Explicitly mark uncertain information:

```json
{
  "dates": {
    "confirmed": false,
    "tentative": "June 2027",
    "confidence": 0.6,
    "source": "Organizer announcement Nov 2026"
  }
}
```

### Empty Results

Always explain why no results were found:

```json
{
  "results": [],
  "explanation": "No events found in Hermanus during August 2027 matching interest 'rock climbing'. There are 12 other events in Hermanus during this period.",
  "suggestions": [
    "Remove the 'rock climbing' filter to see all events",
    "Expand date range to include July or September",
    "Search nearby locations like Cape Town (80km away)"
  ]
}
```

## Validation Strategy

Test these agent scenarios before considering API complete:

### Scenario 1: Basic Search
**Agent Query**: "Events in Hermanus in September"
**Expected**: Agent successfully calls API, receives results, presents to user

### Scenario 2: Seasonal Query
**Agent Query**: "When can we see whales in Hermanus?"
**Expected**: Agent recognizes seasonal question, calls appropriate endpoint, explains season with peak timing

### Scenario 3: Interest Filtering
**Agent Query**: "Family-friendly cultural events in Hermanus this summer"
**Expected**: Agent extracts multiple filters, applies them, returns relevant subset

### Scenario 4: Booking Urgency
**Agent Query**: User planning August trip in July (1 month ahead)
**Expected**: Agent proactively warns about events requiring advance booking that are approaching deadline

### Scenario 5: Ambiguity Handling
**Agent Query**: "Next summer" (ambiguous year)
**Expected**: API returns helpful error, agent asks clarifying question

## Tech Stack Considerations

### Simple Over Clever

Per Magic Safari principles:
- REST over GraphQL (more agents understand REST)
- JSON over Protocol Buffers (more human-readable)
- Standard HTTP status codes (agents know how to handle them)

### Documentation

- OpenAPI/Swagger spec for machine-readable API documentation
- Example requests/responses for every endpoint
- Agent-specific usage guide with common patterns

### Rate Limiting

Design for agent usage patterns:
- Agents may make burst queries (conversation turn might generate 3-4 API calls)
- Rate limit per conversation/session, not per individual request
- Return helpful rate limit info in headers

## Future Considerations

**Multi-modal responses**: May want to support image/map responses for certain queries

**Streaming**: For long-running queries, consider SSE or WebSocket for progressive results

**Caching**: Agent queries may be repetitive within a session - consider response caching with appropriate TTLs
