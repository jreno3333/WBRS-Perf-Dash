# Executive Summary Dashboard — Implementation Plan

## Overview
Replace the current AI Analysis page (`/ai-analysis`) with an **Executive Summary** dashboard designed for a CEO who needs to catch trends before they become problems — and spot outperformers — across all restaurants and markets at a glance.

The page will be a dense, scannable view organized into **trend sections**, each showing directional indicators (improving/declining/stable) per restaurant and rolled up by market. No free-form AI chat — this is a structured, data-driven command center.

---

## Page Layout (Top → Bottom)

### 1. Header & Controls
- Title: "Executive Summary"
- **Period selector**: 7-day (default) / 14-day / 30-day toggle
- **Market filter**: All Markets / specific market dropdown
- **Date anchor**: defaults to today, date picker to shift window
- Last-updated timestamp

### 2. Company-Wide Pulse (Top KPI Row)
A single row of 5-6 summary cards showing **company-wide** metrics with trend arrows:

| Card | Metric | Trend Source |
|------|--------|-------------|
| Sales | Total sales, % vs prior period | `daily_sales` current vs previous period |
| Transactions | Total order count, % change | `posOrders` count |
| Check Average | Avg $/transaction, % change | POS total / count |
| OSAT Score | Avg 5-star %, % change | `daily_osat` |
| Google Rating | Avg rating, % change | `daily_google_reviews` |
| Speed of Service | Avg % cars under 6 min, % change | `hmeTimerData` speedAttainment |

Each card: current value, prior-period value, % change with green/red/gray arrow.

### 3. Attention Required — Declining Trends (Alert Section)
Auto-detected items that are **getting worse** (current period vs prior period, exceeding threshold). Sorted by severity. Each row shows:
- Restaurant name (market tag)
- Metric that's declining
- Current vs prior value
- % change (red)
- Streak indicator (how many consecutive periods declining, if available)

**Thresholds for "attention required"**:
- OSAT dropped > 5 percentage points
- Google rating dropped > 0.2 stars
- Sales down > 10% vs prior period
- Speed of service attainment dropped > 10 points
- Check average dropped > $0.50
- Staffing compliance < 80%
- Manager coverage gaps > 15% of operating hours

### 4. Outperformers — Rising Stars (Celebration Section)
Same structure, but for **improving** metrics that exceed thresholds:
- OSAT improved > 5 pts
- Google rating up > 0.2 stars
- Sales up > 10%
- Speed attainment up > 10 pts
- Check average up > $0.50
- Peak sales hours (>$2K hours increasing)

### 5. Restaurant Trend Table (Core Detail)
A sortable, filterable table with one row per restaurant. Columns:

| Column | Data | Visual |
|--------|------|--------|
| Restaurant | Name + market badge | Text |
| Sales Trend | Current vs prior period % | Arrow + color |
| Transaction Trend | Order count % change | Arrow + color |
| Check Avg Trend | $/order % change | Arrow + color |
| OSAT Trend | 5-star % change | Arrow + color |
| Google Trend | Rating change | Arrow + color |
| Speed Trend | Attainment % change | Arrow + color |
| Staff Compliance | Compliance % | Badge (green/yellow/red) |
| Channel Mix | Mini inline bar (DT/DI/App/3PD) | Stacked bar |

- Sortable by any column
- Color coding: green (improving > threshold), red (declining > threshold), gray (stable)
- Click row to expand inline detail (daily sparkline for each metric over the period)

### 6. Market Rollup Section
Collapsible section grouping restaurants by market with aggregated trends:
- Market name + restaurant count
- Aggregated sales/OSAT/speed/staffing metrics (averaged across units in market)
- Same trend arrows as company-wide pulse
- Expandable to show individual restaurants within that market

### 7. Channel Performance Summary
A section showing **order channel trends** across all restaurants:
- Dine-In % change (current vs prior)
- Drive-Through % change
- App Orders % change
- 3PD/Delivery % change
- Visual: grouped bar chart showing channel mix shift
- Per-restaurant breakdown available on expand

---

## Backend: New API Endpoint

### `GET /api/executive-summary?days=7&date=YYYY-MM-DD`

Single endpoint that returns all data needed for the page. Computes current period vs prior period for every metric, per restaurant.

**Response shape:**
```typescript
{
  dateRange: { start, end, days },
  previousPeriod: { start, end },
  companyPulse: {
    sales: { current, previous, change, pctChange },
    transactions: { current, previous, change, pctChange },
    checkAverage: { current, previous, change, pctChange },
    osat: { current, previous, change, pctChange },
    googleRating: { current, previous, change, pctChange },
    speedAttainment: { current, previous, change, pctChange },
  },
  restaurants: [{
    id, name, marketId, marketName,
    sales: { current, previous, pctChange },
    transactions: { current, previous, pctChange },
    checkAverage: { current, previous, pctChange },
    osat: { current, previous, pctChange },
    googleRating: { current, previous, pctChange },
    speedAttainment: { current, previous, pctChange },
    staffCompliance: { compliancePct, managerCoveragePct },
    channelMix: { driveThru, dineIn, app, delivery },
    prevChannelMix: { driveThru, dineIn, app, delivery },
  }],
  alerts: [{ restaurantId, restaurant, metric, current, previous, pctChange, severity }],
  outperformers: [{ restaurantId, restaurant, metric, current, previous, pctChange }],
  marketRollups: [{
    marketId, marketName, restaurantCount,
    sales: { current, previous, pctChange },
    osat: { current, previous, pctChange },
    speedAttainment: { current, previous, pctChange },
    // ... same structure as companyPulse
  }],
}
```

**Data sources** (all existing tables, no new schemas):
- `daily_sales` → sales per restaurant per period
- `posOrders` (MySQL) → transactions, check average, channel mix
- `daily_osat` → OSAT scores
- `daily_google_reviews` → Google ratings
- `hmeTimerData` → speed of service
- `hourly_labor` → staffing compliance
- `markets` + `restaurantMarkets` → market groupings

All queries run in parallel via `Promise.all()` for performance.

---

## Frontend Implementation

### File: `client/src/pages/ai-analysis.tsx` (replace entirely)

**Key Components:**
1. `ExecutiveSummary` — main page component
2. `CompanyPulseCards` — top KPI row (reusable Card components)
3. `AlertsSection` — declining trends with severity sorting
4. `OutperformersSection` — improving trends
5. `RestaurantTrendTable` — sortable table with inline sparklines
6. `MarketRollupSection` — collapsible market groups
7. `ChannelMixSection` — channel trend visualization
8. `TrendArrow` — small reusable component (up/down/flat arrow + color)

**State Management:**
- `useQuery` for fetching `/api/executive-summary`
- Local state: days (7/14/30), market filter, sort column, sort direction, expanded rows

**Existing Components to Reuse:**
- `NavBar` for navigation
- Radix UI `Card`, `Badge`, `Button`, `Select`, `Tabs`, `Collapsible`
- Recharts for sparklines/mini-charts

---

## Implementation Steps

### Step 1: Backend — Create `/api/executive-summary` endpoint
- New file: `server/routes/executive-summary.ts`
- Register in `server/routes/index.ts`
- Queries: sales, transactions, check avg, OSAT, Google, speed, staffing, channel mix — all current vs prior period, per restaurant
- Compute alerts (declining) and outperformers (improving) server-side
- Market rollups computed server-side

### Step 2: Frontend — Replace `ai-analysis.tsx`
- Build the full Executive Summary page
- Company Pulse KPI cards at top
- Alerts (declining) section
- Outperformers (improving) section
- Restaurant trend table (sortable, expandable)
- Market rollup section
- Channel mix section
- Period selector + market filter controls

### Step 3: Update Navigation
- Update nav label from "AI Analysis" to "Executive Summary" in NavBar
- Keep the same `/ai-analysis` route path for URL stability

### Step 4: Polish & Edge Cases
- Loading states with skeletons
- Empty states (no data for period)
- Mobile-responsive layout
- Error handling

---

## What's NOT Changing
- Database schema — all data already exists
- Other pages — dashboard, history, leaders, etc. remain as-is
- Route path `/ai-analysis` stays the same (just new content)
- The old AI chat/query feature is removed (it was underutilized vs. this structured view)

## Key Design Decisions
- **Server-side trend computation**: Alerts and outperformers computed on backend to keep frontend simple
- **Single API call**: One endpoint returns everything to minimize round-trips
- **Period-over-period comparison**: Always compare current N days vs prior N days for consistent trending
- **Thresholds are hardcoded initially**: Can be made configurable later via settings
