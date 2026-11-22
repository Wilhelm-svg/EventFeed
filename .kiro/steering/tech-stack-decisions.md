# Tech Stack Decisions

Technology choices for the EventFeed product, based on Magic Safari principles and problem requirements.

## Guiding Principles

From Magic Safari Handbook:

1. **Simple over clever**: Avoid tech wankery, focus on shipping value
2. **Boring technology**: Pick boring tech where we can
3. **Avoid premature optimization**: Optimize for speed of shipping first
4. **Understand the layer below**: Avoid "magic" tools we can't debug
5. **AI amplification**: Use tools that work well with AI-assisted development

## Recommended Stack

### Core Languages

**Primary: TypeScript**
- **Why**: Type safety helps catch errors early, excellent AI tooling, runs everywhere (server + client)
- **Use for**: API server, business logic, data processing
- **Tradeoff**: Slightly more verbose than JavaScript, but worth it for large codebase

**Secondary: Python (if needed)**
- **Why**: Strong for data processing, ML pipelines, scraping
- **Use for**: Data ingestion pipelines, if we need to process unstructured event data
- **Tradeoff**: Another language to maintain, but worth it if data processing gets complex

### Backend Framework

**Recommendation: Next.js API Routes OR FastAPI**

**Option A: Next.js (TypeScript)**
- **Pros**: 
  - Full-stack TypeScript
  - Built-in API routes
  - Great for adding web UI later
  - Strong AI coding assistant support
- **Cons**: 
  - Opinionated about structure
  - May be overkill if we don't need UI soon

**Option B: FastAPI (Python)**
- **Pros**:
  - Extremely fast to build APIs
  - Automatic OpenAPI documentation
  - Great type hints
  - Good for data-heavy workloads
- **Cons**:
  - Different language from frontend (if we add one)
  - Python deployment slightly more complex than Node

**Decision**: Start with **Next.js API Routes** unless we identify heavy data processing needs early. Can always add FastAPI service later if needed.

### Database

**Recommendation: PostgreSQL (with Prisma ORM for TypeScript OR SQLAlchemy for Python)**

**Why Postgres**:
- Industry standard, boring (good thing)
- Excellent JSON support (flexible schema for event temporal data)
- Strong date/time handling (critical for event queries)
- PostGIS extension available if we need geospatial queries
- Can scale when needed, but simple to start

**Why NOT other options**:
- ❌ MongoDB: Flexible schema sounds good but leads to data quality issues
- ❌ DynamoDB: Over-engineered for this use case, harder to query
- ❌ MySQL: Postgres has better JSON and date handling

**ORM Choice**:
- If TypeScript → **Prisma**: Excellent DX, type-safe, great migrations
- If Python → **SQLAlchemy**: Industry standard, flexible

### Hosting & Infrastructure

**Recommendation: Start Simple, Scale Later**

**Phase 1 (MVP)**:
- **API Server**: Railway, Render, or DigitalOcean App Platform
  - All provide: Simple deploy, auto-scaling, good DX
  - Railway has best DX for early stage
- **Database**: Managed Postgres on same platform (Railway, Render) or Supabase
- **File Storage** (if needed): Cloudflare R2 or S3

**Why NOT serverless (Vercel, AWS Lambda) for API**:
- Cold starts for API queries are annoying
- More complex to debug
- We're not at scale yet where it matters

**Phase 2 (When we have traction)**:
- Move API to DigitalOcean/Cloudflare Workers if cost matters
- Consider read replicas for database
- Add Redis for caching

### API Documentation

**Recommendation: OpenAPI (Swagger)**

**Why**:
- Industry standard
- AI agents understand it
- Auto-generated docs
- Can generate client SDKs if needed

**Implementation**:
- FastAPI: Built-in OpenAPI generation
- Next.js: Use `swagger-jsdoc` + `swagger-ui-express`

### Testing

**Recommendation: Vitest + Playwright**

**Vitest** (unit/integration tests):
- Fast, works with TypeScript
- Better DX than Jest
- Good AI assistant support

**Playwright** (if we add UI):
- Cross-browser testing
- Can test API endpoints too

**Testing Philosophy** (from Golden Rules):
- Write tests for new features
- Write tests that reproduce bugs before fixing
- Don't over-test - focus on critical paths

### Development Tools

**Code Quality**:
- ESLint + Prettier (standard TypeScript setup)
- Husky for pre-commit hooks
- **Keep it simple** - don't add linting rules that slow us down

**AI Coding Assistants**:
- Cursor, GitHub Copilot, or similar
- Whole team should use AI assistance
- Build playbooks for repeated patterns

**Database Management**:
- Prisma Studio (if using Prisma) - great visual DB tool
- TablePlus or Postico for direct DB access

### Date/Time Handling

**Recommendation: date-fns OR Temporal API (when stable)**

**Why date-fns**:
- Simple, pure functions
- Works with native Date objects
- Good for parsing natural language dates
- Tree-shakeable (small bundle)

**Why NOT moment.js**:
- Large bundle size
- Mutable API (error-prone)
- Unmaintained

**For Natural Language Date Parsing**:
- **Chrono** library: "August 2027", "next summer", etc.
- Accepts natural input, returns structured dates

### Environment Configuration

**Recommendation: .env files + Zod for validation**

```typescript
// Use Zod to validate env variables at startup
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  API_PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test'])
});

export const env = envSchema.parse(process.env);
```

**Why**: Fail fast on misconfiguration, self-documenting, type-safe.

## Data Ingestion Strategy

**Phase 1: Manual Curation**
- Build admin interface (or use Sanity CMS) to manually add events
- Focus on quality over quantity
- Learn what data we actually need

**Phase 2: Semi-Automated**
- Scrape specific known sources (event websites, tourism boards)
- Human review before publishing
- Build reusable scrapers (playbook principle)

**Phase 3: AI-Assisted (Future)**
- AI agents search and suggest events
- Human approval workflow
- Learn from corrections

**Tools**:
- Web scraping: **Playwright** (can handle JS-heavy sites)
- HTML parsing: **Cheerio** (jQuery-like, simple)
- AI extraction: Claude/GPT with structured output

## Build Execution Plan

Per "skeleton for the design", size by risk and impact:

### Step 1: Database Schema (HIGH RISK, HIGH IMPACT)
**Why first**: Everything depends on getting the data model right
**Validation**: Can we represent all event types? Run through hand-worked examples
**Output**: Prisma schema + migrations

### Step 2: Core API - Read Endpoints (MEDIUM RISK, HIGH IMPACT)
**Why**: Proves the data model works, enables agent testing
**Validation**: Can agents successfully query events?
**Output**: GET /api/events/search, GET /api/events/{id}

### Step 3: Manual Data Entry (LOW RISK, MEDIUM IMPACT)
**Why**: Need real data to test queries
**Validation**: Enter 20-30 Hermanus events by hand, ensure quality
**Output**: Seed data script OR admin UI

### Step 4: Agent Integration Testing (MEDIUM RISK, HIGH IMPACT)
**Why**: Validates that APIs are actually agent-friendly
**Validation**: Get Claude to query the API and answer user questions
**Output**: Example agent prompts + test conversations

### Step 5: Write Endpoints (MEDIUM RISK, MEDIUM IMPACT)
**Why**: Enable programmatic event creation
**Validation**: Can we bulk-import events reliably?
**Output**: POST /api/events, PUT /api/events/{id}

### Step 6: Data Ingestion Pipeline (LOW RISK, LOW IMPACT)
**Why**: Automate data gathering, but quality > quantity
**Validation**: Scraper runs reliably, data quality checks pass
**Output**: Scrapers + import scripts

### Step 7: Booking Recommendations API (LOW RISK, MEDIUM IMPACT)
**Why**: Nice-to-have feature for trip planning
**Validation**: Correctly identifies booking deadlines
**Output**: GET /api/booking/recommendations

## Open Questions

### Question 1: Use a CMS for event management?

**Options**:
- Build custom admin UI
- Use headless CMS (Sanity, Strapi, Contentful)

**Recommendation**: Start without CMS, add later if needed

**Reasoning**: 
- PRO CMS: Fast to set up, non-technical users can edit
- CON CMS: Another dependency, may constrain data model
- Current need: We don't have non-technical users yet
- Decision: Build simple API-based admin, revisit if we hire content managers

### Question 2: Real-time vs batch data updates?

**Options**:
- Real-time: Events update immediately when scraped
- Batch: Nightly/hourly import jobs

**Recommendation**: Batch updates (nightly)

**Reasoning**:
- Events don't change minute-to-minute
- Batch allows for quality checks before publishing
- Simpler architecture
- Can add real-time later if needed

### Question 3: Public API vs Internal Only?

**Options**:
- Public API with authentication
- Internal only, just for our agents

**Recommendation**: Start internal, design for public future

**Reasoning**:
- Don't know if external demand exists yet
- Public API requires rate limiting, auth, abuse prevention
- But design APIs as if they were public (good discipline)
- Easy to open later if we add auth

## Non-Goals (Avoid Gold-Plating)

Per Magic Safari principles - avoid these until proven necessary:

❌ GraphQL - REST is simpler for agents
❌ Microservices - Monolith until we hit real scaling issues
❌ Real-time subscriptions - Events don't update that often
❌ Mobile app - API-first, can add later
❌ Advanced caching (Redis) - Not needed at this scale
❌ ML-based event classification - Manual tagging fine for now
❌ Multi-region deployment - Single region until we have global usage

## Success Metrics

How we'll know the tech choices were right:

✅ Can ship MVP in 2-4 weeks
✅ AI agents can successfully use the API
✅ Database can handle all event type variations
✅ New team members can understand the codebase quickly
✅ Can add features without major refactoring
✅ Deployment is simple (one command)
✅ Debugging is straightforward (no "magic" layers)

## Stack Summary

```
Language: TypeScript
Runtime: Node.js
Framework: Next.js (API Routes)
Database: PostgreSQL
ORM: Prisma
Hosting: Railway (MVP) → DigitalOcean (Scale)
Testing: Vitest + Playwright
API Docs: OpenAPI/Swagger
Date Handling: date-fns + Chrono
Validation: Zod
```

**Total new tech to learn**: Minimal. Standard, boring choices that work.
