# WBRS Performance Dashboard — Architecture Reference

> **Purpose**: Living reference document for understanding the system's data integrations, dependencies, and architectural boundaries. Use this when evaluating changes to external providers, adding new modules, or onboarding new systems.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Current External Integrations](#2-current-external-integrations)
3. [7shifts Deep Dive — Dependencies and Replacement Considerations](#3-7shifts-deep-dive)
4. [Data Model & Entity Relationships](#4-data-model--entity-relationships)
5. [Cross-System Identity: How Locations Are Linked](#5-cross-system-identity-how-locations-are-linked)
6. [Sync Pipeline & Scheduler Architecture](#6-sync-pipeline--scheduler-architecture)
7. [Frontend Data Consumption Patterns](#7-frontend-data-consumption-patterns)
8. [Replacing 7shifts — Migration Playbook](#8-replacing-7shifts--migration-playbook)
9. [Planned Module Roadmap & Integration Points](#9-planned-module-roadmap--integration-points)
10. [Appendix: Environment Variables](#10-appendix-environment-variables)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    WBRS Performance Dashboard                    │
│                                                                  │
│  ┌──────────┐   ┌───────────┐   ┌──────────┐   ┌────────────┐  │
│  │  React    │   │  Express  │   │ Postgres │   │ Scheduler  │  │
│  │  Frontend │◄─►│  API      │◄─►│ Database │◄──│ (5-min     │  │
│  │  (Vite)   │   │  Server   │   │ (Drizzle)│   │  polling)  │  │
│  └──────────┘   └───────────┘   └──────────┘   └─────┬──────┘  │
│                                                        │         │
│  ┌─────────────────────────────────────────────────────┼───────┐ │
│  │                External Data Sources                 │       │ │
│  │                                                      ▼       │ │
│  │  ┌──────────┐ ┌────────┐ ┌─────┐ ┌─────────┐ ┌──────────┐ │ │
│  │  │ 7shifts  │ │ Xenial │ │ HME │ │Qualtrics│ │ Google   │ │ │
│  │  │ (Labor)  │ │ (POS)  │ │(D/T)│ │ (OSAT)  │ │ Places   │ │ │
│  │  └──────────┘ └────────┘ └─────┘ └─────────┘ └──────────┘ │ │
│  │  ┌──────────┐ ┌────────────┐                                │ │
│  │  │Workstream│ │ Weather API│                                │ │
│  │  │(Hiring)  │ │ (Open-Meteo│                                │ │
│  │  └──────────┘ └────────────┘                                │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Stack**: TypeScript monorepo — Express 5 + React 18 + PostgreSQL + Drizzle ORM
**Hosting**: Replit (deployment via `replit.nix`/`.replit` config)
**Auth**: Passwordless magic-link via Resend email
**Real-time**: 5-minute polling scheduler + Xenial webhook for POS

---

## 2. Current External Integrations

| Integration | Role | Sync Method | Frequency | Key File(s) |
|---|---|---|---|---|
| **7shifts** | Labor management: sales forecasts, labor hours, time punches, employees, roles, shifts | REST API v2 (polling) | Every 5 min (daily + hourly); hourly (crew) | `server/scraper/7shifts-api.ts` |
| **Xenial POS** | Real-time point-of-sale transactions | Inbound webhook | Real-time (event-driven) | `server/xenial-webhook.ts` |
| **HME Cloud** | Drive-thru timer metrics (car count, service time) | REST API (polling) | Every 5 min | `server/scraper/hme-api.ts` |
| **Qualtrics** | Customer satisfaction surveys (OSAT) | IDP export + CSV parse | Every 5 min | `server/scraper/qualtrics-api.ts` |
| **Google Places** | Restaurant Google review ratings & counts | REST API | Hourly | `server/google-places.ts` |
| **Workstream** | Hiring pipeline & applicant tracking | REST API | On-demand | `server/scraper/7shifts-scraper.ts` |
| **Open-Meteo** | Weather data (current + historical) | REST API | Hourly + end-of-day snapshot | `server/utils/weather.ts` |
| **Resend** | Transactional email (magic links, daily reports) | REST API | On-demand | `server/email.ts` |

---

## 3. 7shifts Deep Dive

### 3.1 What 7shifts Provides Today

7shifts is the **primary data backbone** of the system. It provides:

| Data Domain | 7shifts Endpoint | What We Extract | Where It's Stored |
|---|---|---|---|
| **Locations** | `GET /v2/company/{id}/locations` | Name, timezone, lat/lng, address | `restaurants` table |
| **Daily Sales** | `GET /v2/reports/daily_sales_and_labor` | actual_sales, projected_sales, labor_percent, projected_labor_cost | `dailySales`, `dailyLabor` |
| **Hourly Sales** | `GET /v2/company/{id}/location/{loc}/daily_stats` | Per-hour actual/projected/past_actual sales, actual/projected labor | `hourlySales`, `hourlyLabor` |
| **Time Punches** | `GET /v2/company/{id}/time_punches` | clock-in/out times, role_id, user_id, breaks | Transformed into hourly labor hours by position |
| **Roles** | `GET /v2/company/{id}/roles` | role_id → position name mapping (Manager, Team Member, Grill, etc.) | Used in-memory during labor calculations |
| **Scheduled Shifts** | `GET /v2/company/{id}/shifts` | Start/end times, role assignments | Used to detect Operators (who don't punch in) |
| **Employees/Users** | `GET /v2/company/{id}/users` | Name, hire_date, invited_at, type, active status, location_id | `employees` table |
| **Crew Composition** | Derived from time punches + employees | Hourly crew counts, tenure categories, experience scores | `hourlyCrew` table |

### 3.2 7shifts-Specific Concepts Embedded in the System

These are the terms, IDs, and business logic that are **tightly coupled** to 7shifts:

#### Location Identity
- **`location.name`**: Used as the **primary matching key** between 7shifts and the `restaurants` table. Format: `"1237 - Athens"`. The sync function (`syncLocationsFromAPI()`) matches by exact name via `eq(restaurants.name, location.name)`.
- **`location.id`** (numeric): Stored as `locationCode` in `dailySales`. Also stored in `locationMapping.sevenShiftsLocationId` for cross-referencing with Xenial POS.
- **`location.timezone`**: Copied to `restaurants.timezone`. Defaults to `"America/Chicago"` if missing.

#### Employee & Role Identity
- **`seven_shifts_user_id`**: Integer, stored in `employees.sevenShiftsUserId` as a unique key. This is the canonical employee identifier across the system.
- **`role_id`** → position name: Mapped at runtime via `getRoles()`. Position names (e.g., "Manager", "Shift Supervisor", "Team Member", "Grill", "Counter") flow into `positionBreakdown` JSON fields and `employees.position`.
- **`user.type`**: Values are `"employee"`, `"manager"`, `"asst_manager"`, `"employer"`. Stored in `employees.type`.
- **`hire_date`** vs **`invited`**: 7shifts provides `hire_date` (YYYY-MM-DD, nullable) and `invited` (ISO timestamp). The system falls back to `invited` when `hire_date` is null for tenure calculations.

#### Labor Calculation Dependencies
- **Time Punch Structure**: The system depends on `clocked_in`/`clocked_out` ISO timestamps with timezone offsets, `role_id` for position mapping, and `breaks[]` array structure.
- **Operator Detection**: Operators are detected by checking if a scheduled shift's role name includes "Operator". They're marked with `_operatorScheduled: 1` in the position breakdown because they typically don't clock in/out.
- **Labor Hours Calculation**: Fractional overlap of each time punch with hourly boundaries (e.g., a punch from 10:30-11:30 contributes 0.5 hours to hour 10 and 0.5 hours to hour 11).
- **Overnight Shift Handling**: 4-hour padding before/after the business day to catch shifts that span midnight.

#### Tenure Categories (Hardcoded)
| Category | Threshold | Weight (Experience Score) |
|---|---|---|
| Trainee | < 3 months | 25 |
| Developing | 3–6 months | 50 |
| Experienced | 6–12 months | 75 |
| Veteran | 12+ months | 100 |

#### Sales Data Conventions
- **Cents vs. Dollars**: 7shifts returns `actual_sales`, `projected_sales` in **integer cents**. The system divides by 100 throughout.
- **`labor_percent`**: Returned as a decimal (0–1). Multiplied by 100 before storage.
- **`projected_labor_cost`**: Also in cents; divided by 100 for storage.

### 3.3 Files with Direct 7shifts Coupling

| File | Lines | Coupling Type |
|---|---|---|
| `server/scraper/7shifts-api.ts` | ~1,960 | Core API client, all sync functions |
| `server/scraper/7shifts-scraper.ts` | ~391 | Browser scraper fallback (Playwright) |
| `server/scheduler.ts` | ~546 | Imports and orchestrates all 7shifts sync functions |
| `server/xenial-webhook.ts` | ~407 | `seedLocationMappings()` contains hardcoded 7shifts location IDs |
| `shared/schema.ts` | ~710 | `employees.sevenShiftsUserId`, `locationMapping.sevenShiftsLocationId`, `dailySales.locationCode` |
| `server/storage.ts` | ~450+ | Labor data lookup keys reference hourly labor populated by 7shifts |

---

## 4. Data Model & Entity Relationships

```
restaurants (canonical store record)
├── dailySales         (1 row/day/restaurant - from 7shifts, overlaid by Xenial POS)
├── dailyLabor         (1 row/day/restaurant - from 7shifts)
├── hourlySales        (1 row/hour/restaurant - from 7shifts, overlaid by Xenial POS)
├── hourlyLabor        (1 row/hour/restaurant - from 7shifts time punches)
├── hourlyCrew         (1 row/hour/restaurant - derived from time punches + employees)
├── hmeTimerData       (1 row/hour/restaurant - from HME Cloud)
├── osatData           (1 row/hour/restaurant - from Qualtrics)
├── dailyOsat          (1 row/day/restaurant - aggregated from osatData)
├── osatCategoryIssues (1 row/survey response - from Qualtrics)
├── dailyGoogleReviews (1 row/day/restaurant - from Google Places)
├── dailyWeather       (1 row/day/restaurant - from Open-Meteo)
├── posOrders          (1 row/transaction - from Xenial webhook)
├── employees          (1 row/employee - from 7shifts, linked via sevenShiftsUserId)
├── applicants         (1 row/applicant - from Workstream)
└── locationMapping    (cross-reference: xenialStoreNumber ↔ restaurantId ↔ sevenShiftsLocationId)

markets ──┐
          ├── restaurantMarkets (junction table, many-to-many)
restaurants──┘

Arena (gamification):
├── arenaConfig        (singleton JSON config)
├── arenaBadgesEarned  (log of badges earned)
├── arenaStreaks        (active/historical streaks)
├── arenaRecords       (company records)
├── arenaMessages      (praise/coaching messages)
└── arenaBadgeImages   (custom badge artwork)
```

### Key Identity Columns

| Column | Table | Source System | Purpose |
|---|---|---|---|
| `restaurants.id` | `restaurants` | Internal (UUID) | **Primary key for everything** — all child tables FK to this |
| `restaurants.name` | `restaurants` | 7shifts `location.name` | Matching key for syncs. Format: `"1237 - Athens"` |
| `restaurants.unitNumber` | `restaurants` | Parsed from name | Store number (e.g., `"1237"`) |
| `employees.sevenShiftsUserId` | `employees` | 7shifts `user.id` | Employee identity. Unique constraint. |
| `locationMapping.xenialStoreNumber` | `locationMapping` | Xenial POS | Cross-reference to POS |
| `locationMapping.sevenShiftsLocationId` | `locationMapping` | 7shifts `location.id` | Cross-reference to labor system |
| `dailySales.locationCode` | `dailySales` | 7shifts `location.id` | Which 7shifts location this row came from |
| `applicants.workstreamLocationId` | `applicants` | Workstream | Hiring platform location ID |

---

## 5. Cross-System Identity: How Locations Are Linked

This is the **most critical architecture concern** for adding or replacing integrations. Every external system has its own location identifier, and they are currently linked through fragile name-matching and a hardcoded mapping table.

```
             7shifts                  Xenial POS              Workstream
             location.id             store_number            digest_key
             (e.g., 298133)          (e.g., "1237")          (e.g., "abc123")
                  │                       │                       │
                  ▼                       ▼                       ▼
    ┌──── location.name ────┐    ┌── storePrefix ──┐    ┌── name match ──┐
    │  "1237 - Athens"      │    │  "1237 - "       │    │  fuzzy match   │
    └──────────┬────────────┘    └────────┬─────────┘    └───────┬────────┘
               │                          │                      │
               ▼                          ▼                      ▼
         ┌─────────────────────────────────────────────────────────┐
         │              restaurants.id (internal UUID)              │
         │              restaurants.name = "1237 - Athens"          │
         └─────────────────────────────────────────────────────────┘
                                    ▲
                                    │
                          locationMapping table
                   xenialStoreNumber ↔ restaurantId ↔ sevenShiftsLocationId
```

### Current Matching Strategies

| From → To | Method | Fragility |
|---|---|---|
| 7shifts → restaurants | Exact match on `location.name` | **High** — renaming a location in 7shifts breaks sync |
| Xenial → restaurants | Regex match: `restaurant.name.match(/^(\d{4})\s*-/)` | **Medium** — depends on "NNNN - CityName" naming convention |
| Xenial → 7shifts | Hardcoded mapping array in `xenial-webhook.ts:340-362` | **Very High** — new locations require code change |
| Workstream → restaurants | Name matching during sync | **High** — depends on naming consistency |
| Google Places → restaurants | `googlePlaceId` stored on restaurant record | **Low** — explicit ID linkage |
| HME → restaurants | Matched by restaurant name patterns | **High** — relies on naming convention |

### Recommended Future State

A **canonical location registry** with explicit foreign keys per integration:

```
restaurants
├── id (UUID, internal)
├── unitNumber ("1237")
├── displayName ("Athens")
├── sevenShiftsLocationId (298133)    ← currently in locationMapping
├── xenialStoreNumber ("1237")        ← currently in locationMapping
├── workstreamLocationId ("abc123")   ← currently in workstreamLocations
├── hmeDeviceId ("...")               ← currently matched by name
├── googlePlaceId ("ChIJ...")         ← already on restaurants table
├── qualtricsStoreCode ("...")        ← currently matched by name
└── timezone, lat/lng, address, etc.
```

---

## 6. Sync Pipeline & Scheduler Architecture

### Scheduler Flow (every 5 minutes)

```
runScheduledSync()
│
├── 1. fetchSalesFromAPI()              ← 7shifts daily sales + labor %
├── 2. fetchHourlySalesFromAPI()        ← 7shifts hourly intervals + time punch labor
├── 3. syncSalesWithXenialPOS()         ← Overlay Xenial POS data on 7shifts baselines
├── 4. syncHMETimerData()               ← HME drive-thru metrics
├── 5. syncCrewExperienceIfNeeded()     ← Hourly crew (top of hour only)
├── 6. syncGoogleReviewsIfNeeded()      ← Google reviews (top of hour only)
├── 7. syncOsatIfNeeded()               ← Qualtrics OSAT surveys
├── 8. saveEndOfDayWeatherIfNeeded()    ← Weather snapshot (11 PM Central)
├── 9. syncYesterdayIfNeeded()          ← Re-sync yesterday (midnight–6 AM Central)
└── 10. sendDailyReportsIfNeeded()      ← Email reports at configured time
```

### Startup Sequence

1. Check if 7-day historical data exists (needed for week-over-week comparisons)
2. If missing: pause scheduler → backfill 9 days of daily + hourly data → resume
3. Start scheduler (every 5 minutes)
4. Run initial sync immediately
5. Force crew sync for today + yesterday
6. Schedule daily data cleanup (midnight, 730-day retention)

### Data Layering Strategy

The system uses a **layered data approach** where 7shifts provides the baseline and other sources overlay or enrich:

```
Layer 1: 7shifts baseline      → Sales forecasts, projected labor, hourly intervals
Layer 2: Xenial POS overlay    → Replaces 7shifts sales with real-time POS totals
Layer 3: 7shifts time punches  → Actual labor hours by position (separate hourlyLabor table)
Layer 4: HME enrichment        → Drive-thru metrics attached to same hour slots
Layer 5: Qualtrics enrichment  → OSAT scores attached to same hour slots
Layer 6: Google Places         → Daily review snapshots
Layer 7: Weather               → Daily weather context
```

---

## 7. Frontend Data Consumption Patterns

### API Endpoints Consumed

| Endpoint | Returns | Sources Combined |
|---|---|---|
| `GET /api/leaderboard?date=YYYY-MM-DD` | All restaurants with sales, labor, weather, drive-thru, OSAT, Google reviews | 7shifts + Xenial + HME + Qualtrics + Google + Weather |
| `GET /api/hourly-sales/:id?date=...` | Hourly breakdown for one restaurant | 7shifts + Xenial + HME + Qualtrics |
| `GET /api/hourly-labor/:id?date=...` | Hourly labor with position breakdown | 7shifts time punches |
| `GET /api/crew-experience/:id?date=...` | Crew composition with tenure categories | 7shifts employees + time punches |
| `GET /api/leaders` | Staff directory with performance | 7shifts employees + derived metrics |
| `GET /api/arena/*` | Gamification data | Derived from all sources |

### Client-Side Calculations

The frontend performs these calculations with data already fetched:

- **X-Score**: `35% sales pace + 25% drive-thru speed + 25% OSAT + 15% staffing adequacy`
- **Pace Percentage**: `(todaySales / lastWeekSales) × 100` at normalized hour
- **Experience Score**: Weighted average of tenure category counts (25/50/75/100 weights)
- **Labor Model**: Recommended staffing by hour/sales volume (defined in `client/src/lib/labor-model.ts` and `server/labor-model.ts`)

### Data Shape Contracts

The frontend depends on these TypeScript interfaces defined in `shared/schema.ts`:

- `RestaurantSales` — flat object with sales, labor, weather, driveThru, googleReviews, osat
- `HourlySalesData` — per-hour object with sales, labor, positionBreakdown, leaders, HME, OSAT
- `CrewExperienceData` — per-hour crew with tenure mix and team member details
- `LeaderboardData` — wrapper with restaurant array + metadata

**Key observation**: The frontend is **not coupled to any specific external API**. It only consumes the internal API contracts. Any backend provider swap is invisible to the frontend as long as these interfaces are honored.

---

## 8. Replacing 7shifts — Migration Playbook

### What a Replacement System Must Provide

Any labor management system replacing 7shifts must supply equivalent data through its own API:

| Capability | 7shifts Source | Required From Replacement | Critical? |
|---|---|---|---|
| **Location list** | `/v2/company/{id}/locations` | List of all locations with name, timezone, lat/lng | Yes |
| **Daily sales & labor summary** | `/v2/reports/daily_sales_and_labor` | Daily: actual sales, projected sales, labor %, projected labor cost | Yes |
| **Hourly sales intervals** | `/v2/company/{id}/location/{loc}/daily_stats` | Per-hour: actual, projected, last-week sales, actual/projected labor | Yes |
| **Time punches** | `/v2/company/{id}/time_punches` | Per-employee clock in/out with role/position, location, timestamps | Yes |
| **Role/position mapping** | `/v2/company/{id}/roles` | role_id → human-readable position name | Yes |
| **Employee directory** | `/v2/company/{id}/users` | Name, hire_date (or equivalent), active status, type, location | Yes |
| **Scheduled shifts** | `/v2/company/{id}/shifts` | Start/end times with role assignment (needed for Operator detection) | Medium |
| **Sales forecasting** | Embedded in daily_stats | Projected sales by hour and day | Medium |

### Step-by-Step Migration

#### Phase 1: Create Provider Abstraction Layer

Create a `server/providers/` directory with a common interface:

```typescript
// server/providers/labor-provider.ts (proposed interface)
interface LaborProvider {
  getLocations(): Promise<NormalizedLocation[]>;
  getDailySummary(locationId: string, date: string): Promise<DailySummary>;
  getHourlyIntervals(locationId: string, date: string): Promise<HourlyInterval[]>;
  getTimePunches(locationId: string, date: string): Promise<TimePunch[]>;
  getRoles(locationId: string): Promise<RoleMapping[]>;
  getEmployees(locationId?: string): Promise<NormalizedEmployee[]>;
  getScheduledShifts(locationId: string, date: string): Promise<ScheduledShift[]>;
}
```

#### Phase 2: Normalize Identity

Replace name-based matching with explicit ID columns on the `restaurants` table:

1. Add `laborPlatformLocationId` column (replaces `sevenShiftsLocationId` concept)
2. Populate from current 7shifts data
3. Update sync functions to use explicit ID matching instead of name matching

#### Phase 3: Decouple Schema

Rename/migrate 7shifts-specific columns:

| Current Column | Proposed Column | Notes |
|---|---|---|
| `employees.sevenShiftsUserId` | `employees.externalUserId` | + add `employees.externalSource` text field |
| `locationMapping.sevenShiftsLocationId` | `locationMapping.laborPlatformLocationId` | Or fold into restaurants table |
| `dailySales.locationCode` | `dailySales.externalLocationCode` | Generic external reference |

#### Phase 4: Replace API Client

1. Implement the new provider (e.g., `server/providers/hotschedules-provider.ts`)
2. Update `server/scheduler.ts` to import from the new provider
3. Map the new system's data formats to the normalized structures
4. Test with parallel-running (old + new) before cutover

### Hardcoded Values That Must Be Updated

| Value | Location | Action |
|---|---|---|
| `https://api.7shifts.com` | `7shifts-api.ts:139` | Replace with new base URL |
| `SEVENSHIFTS_API_TOKEN` | Multiple files | Replace env var |
| Store ↔ 7shifts ID mapping array | `xenial-webhook.ts:340-362` | Update with new labor system IDs |
| `"America/Chicago"` default timezone | `7shifts-api.ts:674`, `schema.ts:10` | Review — may remain valid |
| Browser scraper URLs | `7shifts-scraper.ts:48,169` | Remove or replace |
| `/v2/` endpoint paths | Throughout `7shifts-api.ts` | Replace with new API paths |

### Data Continuity Concerns

- **Historical Data**: Hourly sales/labor data is stored generically (no 7shifts-specific format in DB rows). A provider swap doesn't lose historical data.
- **Employee Records**: `sevenShiftsUserId` is used as the unique key. A new provider will have different IDs. Plan for a mapping table or employee merge process.
- **Tenure Calculations**: Based on `hire_date` or `invitedAt`. As long as the new system provides a hire date, tenure tracking continues seamlessly.

---

## 9. Planned Module Roadmap & Integration Points

### 9.1 Training System

**Need**: Training tracking, certification management, onboarding workflows tied to employee records.

**Integration Points**:
- **Employees table**: Already synced from 7shifts. A training system needs `employees.id`, `employees.position`, `employees.restaurantId`, `employees.hireDate` for enrollment triggers.
- **Tenure categories**: Trainee (< 3 months) is already calculated. Training modules could use this as a trigger: auto-enroll new hires in onboarding tracks.
- **Crew experience**: `hourlyCrew.crewMembers` already tracks who worked each hour with tenure. Training completion status could be added to this payload.

**Recommended Architecture**:
```
New tables:
  trainingCourses      (id, name, category, requiredForPositions[], durationDays)
  trainingEnrollments  (id, employeeId, courseId, status, enrolledAt, completedAt)
  trainingCertifications (id, employeeId, certType, earnedAt, expiresAt)

New sync trigger:
  When syncEmployees() creates a new employee → auto-enroll in position-appropriate courses
```

**Data Dependencies**: Employee data (from labor platform), position names, location assignment.

### 9.2 Inventory & Ordering

**Need**: Track inventory levels, cost of goods, waste, and tie to product-level sales data.

**Integration Points**:
- **Sales data**: `hourlySales.actualSales` and `posOrders` provide revenue. Product-level sales mix is NOT currently captured (Xenial webhook receives order totals, not line items).
- **POS webhook**: `xenial-webhook.ts` receives full order JSON (`rawJson` column stored). Product/line-item data may already be available in the raw payload but is not currently parsed.

**Recommended Architecture**:
```
New tables:
  products             (id, sku, name, category, unitCost)
  inventoryLevels      (id, restaurantId, productId, quantity, lastCountedAt)
  orderItems           (id, posOrderId, productId, quantity, lineTotal)
  purchaseOrders       (id, restaurantId, vendorId, status, orderedAt)

New data source:
  Parse line items from posOrders.rawJson OR add new Xenial webhook entity type
  Connect to inventory management system (e.g., MarketMan, BlueCart, Restaurant365)
```

**Data Dependencies**: POS transaction data (Xenial), product catalog, vendor data.

### 9.3 User Provisioning & Lifecycle Management

**Need**: When employees are hired/terminated in the labor system, automatically provision/deprovision accounts across other systems (training, POS, communication tools).

**Integration Points**:
- **Employee sync**: `syncEmployees()` already detects new hires (inserts) and status changes (active flag). This is the natural trigger point.
- **Applicant pipeline**: `applicants` table from Workstream tracks `status` ("hired", "rejected"). Hiring events could trigger provisioning.
- **Location transfers**: Currently, `employees.locationId` and `employees.restaurantId` reflect current assignment. Changes during sync could trigger cross-system updates.

**Recommended Architecture**:
```
New concept: ProvisioningWorkflow
  on employee.created:
    → Create training enrollment
    → Send POS system invite
    → Add to communication channel
    → Send welcome email

  on employee.locationChanged:
    → Update POS location access
    → Update training group
    → Notify new/old managers

  on employee.deactivated:
    → Deactivate POS access
    → Remove from active training
    → Archive communication access

New tables:
  provisioningEvents   (id, employeeId, eventType, targetSystem, status, processedAt)
  provisioningRules    (id, trigger, targetSystem, action, config)
```

**Data Dependencies**: Employee lifecycle events (from labor platform), target system APIs.

### 9.4 CRM (Customer Relationship Management)

**Need**: Support team case management, customer interaction tracking, marketing campaign management.

**Integration Points**:
- **OSAT data**: `osatData` and `osatCategoryIssues` already capture customer satisfaction by location/hour/category. Low scores could auto-create support cases.
- **Google Reviews**: `dailyGoogleReviews` tracks rating changes. New negative reviews could trigger case creation.
- **POS data**: `posOrders` could be linked to customer profiles for purchase history.
- **Location data**: `restaurants` table provides geographic context for regional marketing.

**Recommended Architecture**:
```
New tables:
  customers            (id, name, email, phone, preferredLocation, createdAt)
  customerInteractions (id, customerId, restaurantId, channel, type, notes, createdAt)
  supportCases         (id, customerId, restaurantId, category, status, priority, assignedTo)
  marketingCampaigns   (id, name, targetAudience, channel, status, scheduledAt)
  marketingEvents      (id, campaignId, customerId, eventType, occurredAt)

Auto-trigger rules:
  OSAT < 60% for a location → create "OSAT Alert" case
  Google rating drops > 0.2 in a day → create "Review Alert" case
  New 1-star survey response → create individual follow-up case
```

**Data Dependencies**: OSAT (Qualtrics), Google reviews, POS transactions, employee data for case assignment.

### 9.5 Payroll Integration

**Need**: Export labor hours, overtime, and position data to payroll processor.

**Integration Points**:
- **Hourly labor**: `hourlyLabor` has position breakdowns and hours per employee
- **Daily labor**: `dailyLabor` has daily totals and labor cost
- **Employee records**: `employees` has names, positions, locations, hire dates

**Recommended Architecture**:
```
New concept: PayrollExport
  Aggregate hourlyLabor into weekly summaries per employee
  Map positions to pay rates (from payroll system or local config)
  Export format: CSV, API push, or direct integration (ADP, Gusto, Paychex)

New tables:
  payrollExports       (id, periodStart, periodEnd, status, exportedAt)
  payrollLineItems     (id, exportId, employeeId, regularHours, overtimeHours, position)
```

**Data Dependencies**: Time punch data (from labor platform), employee records, pay rate configuration.

### 9.6 Analytics & Financial Export

**Need**: Export operational data to financial systems, BI tools, and accounting platforms.

**Integration Points**:
- **All data tables** are potential export sources
- **Daily sales + labor** are the primary financial metrics
- **POS orders** provide transaction-level detail

**Recommended Architecture**:
```
New concept: DataExport pipeline
  Scheduled exports (daily/weekly/monthly) to:
    → Accounting system (QuickBooks, Xero, NetSuite)
    → BI platform (Looker, Tableau, Power BI)
    → Data warehouse (BigQuery, Snowflake, Redshift)

New tables:
  exportConfigurations (id, name, destination, format, schedule, lastRunAt)
  exportRuns           (id, configId, status, recordCount, startedAt, completedAt)

Export formats:
  CSV → flat file for accounting imports
  JSON API → push to REST endpoints
  SQL → direct database replication
  Webhook → event-driven export on data change
```

---

## 10. Appendix: Environment Variables

### Currently Required

| Variable | Used By | Purpose |
|---|---|---|
| `DATABASE_URL` | `server/db.ts` | Primary PostgreSQL connection |
| `SEVENSHIFTS_API_TOKEN` | `server/scraper/7shifts-api.ts` | 7shifts API bearer token |
| `HME_SERVICE_ACCOUNT` | `server/scraper/hme-api.ts` | HME Cloud auth |
| `HME_AUTH_KEY` | `server/scraper/hme-api.ts` | HME Cloud auth |
| `HME_ACCOUNT_EMAIL` | `server/scraper/hme-api.ts` | HME Cloud auth |
| `QUALTRICS_API_TOKEN` | `server/scraper/qualtrics-api.ts` | Qualtrics auth |
| `QUALTRICS_IDP_SOURCE_ID` | `server/scraper/qualtrics-api.ts` | Qualtrics data project ID |
| `GOOGLE_PLACES_API_KEY` | `server/google-places.ts` | Google Places auth |
| `RESEND_API_KEY` | `server/email.ts` | Email service auth |
| `ALLOWED_LOGIN_EMAILS` | `server/routes/auth.ts` | Whitelist for magic-link login |
| `SESSION_SECRET` | `server/index.ts` | Express session encryption |

### Optional

| Variable | Used By | Purpose |
|---|---|---|
| `XPOSSHARED_DATABASE_URL` | `server/db.ts` | Separate POS database (falls back to `DATABASE_URL`) |
| `SHARED_DATABASE_URL` | `server/db.ts` | Fallback for both DB URLs |
| `RESEND_FROM_EMAIL` | `server/email.ts` | Custom from address |
| `WORKSTREAM_API_TOKEN` | `server/scraper/7shifts-scraper.ts` | Hiring platform auth |
| `GOOGLE_PLACES_LOCATION_CACHE` | `server/google-places.ts` | Cached place IDs (JSON) |
| `SEVENSHIFTS_EMAIL` | `server/scraper/7shifts-scraper.ts` | Browser scraper login |
| `SEVENSHIFTS_PASSWORD` | `server/scraper/7shifts-scraper.ts` | Browser scraper login |

---

## Key Takeaways for Future Development

1. **The frontend is already decoupled** — it consumes normalized TypeScript interfaces. Backend provider swaps do not require frontend changes.

2. **The biggest risk in any migration is location identity** — the current system relies on name matching (`"1237 - Athens"`). Move to explicit ID columns on the `restaurants` table before adding more integrations.

3. **Employee identity is tied to `sevenShiftsUserId`** — any new labor platform will introduce a new ID space. Plan for a mapping/merge strategy.

4. **The scheduler is the integration orchestrator** — all new data sources should follow the same pattern: create a sync function, add it to the scheduler with appropriate frequency and deduplication guards.

5. **The data layering strategy works well** — 7shifts provides baselines, Xenial POS overlays real-time sales, and enrichment sources attach to the same hourly time slots. New modules should follow this pattern.

6. **Hardcoded mappings are a tech debt priority** — the Xenial ↔ 7shifts mapping array in `xenial-webhook.ts:340-362` and the name-matching patterns throughout will not scale as more locations and integrations are added.
