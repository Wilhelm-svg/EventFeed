# EventFeed Project Overview

## The Product

Build an event feed for luxury travel planning. Travel agents planning trips need to know what's happening in a destination while their traveler is there: festivals, concerts, sporting events, markets, exhibitions, wildlife seasons, and other time-sensitive experiences.

## The Context

**Booking Timeline**: Luxury trips are booked 6-18 months in advance. Closer to departure, trips are refined and activities are booked. Planners look at the same place multiple times, months apart.

**User Variance**: Travelers vary widely in age and interests. What's worth knowing differs from one trip to the next.

**First Implementation**: Build for Hermanus, South Africa as the initial location.

## What Counts as an Event

1. **Point-in-time events**: J. Cole in Johannesburg on 12 December 2026, Lions v Munster at Ellis Park on 17 April 2027, Hermanus Country Market on a Saturday
2. **Running events**: Theatre shows with 81 dates, exhibitions open for a year
3. **Future events**: FynArts Festival in Hermanus in June 2027 (months away)
4. **Seasonal events**: Southern right whales off Hermanus, June to November (season with no specific date)
5. **Recurring events**: Weekly markets, monthly concerts, annual festivals

## Solution Requirements

1. **Data model design**: Work out the problem, then model the domain
2. **API design**: Expose the model as agent-friendly APIs
3. **Agent integration**: Get Claude or Codex to use the API and do data processing
4. **Tech stack**: Decide based on problem shape and what we know
5. **Validation**: Tracer bullets and checks in the right places
6. **Iteration**: Build, test, iterate

## Key Design Principles

From "A skeleton for the design.txt":

1. The data model, the interface, and what the agent does
2. Three to five principles: each a rule, and what you accept by choosing it
3. Open decisions: the question, your recommendation, and one example worked under both answers
4. How it is checked: a few cases worked by hand, with the expected result
5. Execution plan: build steps, sized by risk and impact

## Magic Safari Context

This product fits into Magic Safari's mission of building the digital backbone of Africa's safari economy. The event feed helps travel agents provide richer, more informed itineraries by surfacing relevant local experiences that align with traveler interests and timing.
