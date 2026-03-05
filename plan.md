# Code Review: Long-Term Maintainability, Fragmented Calculations & UI Improvements

## Part 1: Fragmented Calculations — Duplicated Logic Across Files

### 1.1 `getCentralDate()` — 3 identical copies
- `client/src/pages/dashboard.tsx:23`
- `client/src/pages/leaders.tsx:14`
- `client/src/pages/crew-experience.tsx:126`

All three are byte-for-byte identical. Should be extracted to a shared `client/src/lib/dates.ts` utility and imported.

### 1.2 `getGradeColor()` — 5 divergent implementations
- `client/src/lib/grading.ts:72` — canonical export (`text-green-500`, etc.)
- `client/src/lib/dayparts.ts:121` — different classes (`text-green-600 dark:text-green-400`)
- `client/src/pages/leaders.tsx:21` — yet another variant (missing D grade, uses `text-amber-500` for C)
- `client/src/pages/performance-history.tsx:113` — dark mode variant (`text-green-600 dark:text-green-400`)
- `client/src/pages/crew-experience.tsx:150` — badge variant with dark mode

These inconsistencies mean the same grade letter shows different colors on different pages. Should consolidate to one canonical set in `grading.ts` with dark-mode support, and have all pages import from there.

### 1.3 `getGradeBgColor()` — local re-definition
- `client/src/pages/performance-history.tsx:121` — local function (uses `bg-green-100 dark:bg-green-900/30`)
- `client/src/lib/grading.ts:80` — canonical export (uses `bg-green-500/10 border-green-500/30`)

Different styles for the same concept. Should unify.

### 1.4 `formatCurrency()` — 7 definitions, 3 different implementations
- `client/src/lib/grading.ts:292` — module-level singleton formatter (best practice)
- `client/src/pages/performance-history.tsx:129` — creates new `Intl.NumberFormat` per call
- `client/src/pages/ai-analysis.tsx:105` — creates new `Intl.NumberFormat` per call
- `client/src/pages/map.tsx:90` — creates new `Intl.NumberFormat` per call
- `client/src/pages/settings.tsx:816` — creates new `Intl.NumberFormat` per call
- `server/lib/scoring.ts:335` — creates new `Intl.NumberFormat` per call
- `server/leader-report.ts:33` — uses `toLocaleString` (different approach entirely)

Pages that create `Intl.NumberFormat` inline on every call waste memory. Should import from `grading.ts`.

### 1.5 `scoreToGradeLabel` / `scoreToGrade` — 4 definitions + aliases
- `server/lib/scoring.ts:48` — canonical server export
- `client/src/lib/grading.ts:43` — canonical client export
- `client/src/lib/dayparts.ts:105` — separate `scoreToGrade` function (identical logic)
- `client/src/components/leaderboard-card.tsx:70` — local `scoreToGrade` function
- `client/src/components/state-breakdown.tsx:48` — alias `const scoreToGrade = scoreToGradeLabel`
- `client/src/components/market-breakdown.tsx:48` — alias `const scoreToGrade = scoreToGradeLabel`

The `dayparts.ts` version should be removed and imports redirected to `grading.ts`.

### 1.6 `gradeToMidpoint` / `gradeToScore` — 3 definitions + aliases
- `server/lib/scoring.ts:64` — canonical server export
- `client/src/lib/grading.ts:60` — canonical client export
- `client/src/lib/dayparts.ts:97` — separate `gradeToScore` function (identical logic, different name)
- `client/src/components/leaderboard-card.tsx:68` — alias `const gradeToScore = gradeToMidpoint`

### 1.7 `formatDate()` — 4 different implementations
- `client/src/pages/heatmap.tsx:27` — `weekday: 'short', month: 'short', day: 'numeric'`
- `client/src/pages/performance-history.tsx:138` — same format
- `client/src/pages/ai-analysis.tsx:109` — splits string, returns `M/D` format
- `client/src/pages/dashboard.tsx:335` — `weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'`

At minimum, the two identical implementations in heatmap and performance-history should share one function.

### 1.8 Labor Model — full duplication between client and server
- `server/lib/labor-model.ts` (176 lines) — full model with types, breakdown, comments
- `client/src/lib/labor-model.ts` (118 lines) — stripped-down duplicate of same data

Both contain identical `NON_PRODUCTION_BY_HOUR`, `BREAKFAST_RAMP_UP`, and `NON_BREAKFAST_RAMP_UP` tables. If any staffing threshold changes, both files must be updated in lockstep. Long-term, this should either be served from the API or imported from a shared package.

---

## Part 2: Long-Term Maintainability Concerns

### 2.1 Dashboard component is a monolith (~870 lines)
`client/src/pages/dashboard.tsx` contains:
- 15+ `useQuery` calls
- 30+ interface definitions inline
- Complex sorting logic
- Holiday comparison rendering
- All wired together in one component

This makes it hard to add features without risking regressions. The inline interface definitions (e.g. `CheckAverageData`, `CheckAverageTrendData`, `RestaurantNote`, `HolidaySalesComparison`, `WeeklySalesData`, `DemandCurveHour`) should be moved to shared type files.

### 2.2 Inline interface definitions are redefined across files
`WeeklySalesData` is defined identically in:
- `client/src/pages/dashboard.tsx:258`
- `client/src/components/summary-cards.tsx:8`

`CheckAverageData` is defined identically in:
- `client/src/pages/dashboard.tsx:127`
- `client/src/components/summary-cards.tsx:18`

These should live in `@shared/schema` or a dedicated types file.

### 2.3 Magic numbers for grade thresholds
Grade thresholds (97, 93, 90, 87, 83, 80, 77, 73, 70, 67, 63, 60) and color thresholds (85% OSAT = green, 80% = yellow, 70% speed = green, 50% = yellow) are hardcoded in many places. While the scoring module centralizes some of this, threshold checks like `osatPct >= 85` appear directly in UI components.

### 2.4 No shared types between client and server for API responses
API response shapes are inferred or redefined on the client side. A `@shared/types` module for API contracts would prevent client-server drift.

---

## Part 3: UI Improvement Proposals

### 3.1 Inconsistent header/nav patterns across pages
Each page builds its own header layout:
- **Dashboard**: Sticky header with date nav + NavBar, compact style
- **Performance History**: Different header structure, NavBar placed in filters area
- **Leaders**: Yet another header layout with NavBar in the controls area
- **Heatmap/Daily AI**: Has its own header pattern

**Proposal**: Extract a shared `<PageHeader>` component that provides consistent header layout with title, date controls (optional), filters (optional), and NavBar placement. This ensures visual consistency and reduces per-page header boilerplate.

### 3.2 No breadcrumbs or "back" navigation
When users navigate to sub-pages (Leaders, Trends, Daily AI, People), there's no breadcrumb trail or quick way to understand the page hierarchy. The NavBar helps, but on mobile the labels are hidden (only icons show).

**Proposal**: Add a simple breadcrumb or page title indicator on mobile that shows which page the user is on.

### 3.3 Mobile nav shows only icons (no labels)
The NavBar hides labels on mobile (`hidden lg:inline`), leaving users with just icons. For a dashboard app where users may not memorize icon meanings, this hurts discoverability.

**Proposal**: Show abbreviated labels on mobile (e.g., "Rank", "AI", "Trend", "Crew", "Map") below or beside the icons at smaller breakpoints, using `sm:inline` instead of `lg:inline`.

### 3.4 Sort dropdown on Rankings page lacks visual cues
The sort dropdown has 11 options but no indication of sort direction (asc/desc) or what the current sort means visually in the list.

**Proposal**: Add a small sort-direction indicator arrow next to the dropdown, and show the active sort metric value prominently on each card.

### 3.5 Date navigation is duplicated (desktop + mobile)
The date picker with prev/next buttons is rendered twice in `dashboard.tsx` — once for desktop (lines 517-561) and once for mobile (lines 567-605). This is nearly identical JSX.

**Proposal**: Extract a `<DateNavigator>` component that handles both responsive layouts internally, reducing ~90 lines of duplication.

---

## Implementation Plan

### Phase 1: Consolidate shared utilities (high impact, low risk)
1. Create `client/src/lib/dates.ts` with `getCentralDate()`, `getYesterdayStr()`, `formatShortDate()`, `formatLongDate()`
2. Remove duplicate `getCentralDate` from `dashboard.tsx`, `leaders.tsx`, `crew-experience.tsx`
3. Remove duplicate `formatCurrency` from `performance-history.tsx`, `ai-analysis.tsx`, `map.tsx`, `settings.tsx` — import from `grading.ts`
4. Remove duplicate `scoreToGrade` / `gradeToScore` from `dayparts.ts` — import from `grading.ts`
5. Unify `getGradeColor` / `getGradeBgColor` in `grading.ts` with dark mode support, remove local copies from `performance-history.tsx`, `leaders.tsx`, `dayparts.ts`

### Phase 2: Extract shared types
6. Move inline interfaces (`WeeklySalesData`, `CheckAverageData`, `CheckAvgTrendData`, etc.) to a shared types file

### Phase 3: UI improvements
7. Extract `<DateNavigator>` component from dashboard.tsx to eliminate desktop/mobile duplication
8. Improve mobile nav labels (show short text at `sm` breakpoint)
9. Extract `<PageHeader>` component for consistent page layouts
