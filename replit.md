# MWB Sales Leaderboard - Restaurant Performance Dashboard

## Overview

A restaurant sales performance dashboard that tracks and compares sales across multiple locations with timezone-normalized comparisons and real-time pace tracking. The application displays a leaderboard ranking restaurants by daily sales, compares current performance against the previous week, and visualizes hourly sales patterns through interactive charts.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter for lightweight client-side routing
- **State Management**: TanStack React Query for server state and caching
- **Styling**: Tailwind CSS with shadcn/ui component library (New York style variant)
- **Charts**: Recharts for data visualization (line/area charts for pace tracking)
- **Build Tool**: Vite with React plugin and path aliasing

The frontend follows a component-based architecture with:
- Pages in `client/src/pages/` (dashboard, not-found)
- Reusable UI components in `client/src/components/ui/` (shadcn/ui)
- Feature components in `client/src/components/` (leaderboard-card, pace-chart, summary-cards)
- Custom hooks in `client/src/hooks/`
- Utilities and query client in `client/src/lib/`

### Backend Architecture
- **Runtime**: Node.js with Express 5
- **Language**: TypeScript with ES modules
- **API Design**: RESTful JSON endpoints under `/api/` prefix
- **Development**: Vite middleware for HMR in development mode
- **Production**: Static file serving from built assets

API Routes:
- `GET /api/leaderboard` - Aggregated restaurant sales rankings with week-over-week comparison
- `GET /api/pace/:restaurantId` - Hourly sales data for pace comparison (use "all" for aggregate)
- `GET /api/restaurants` - List of all restaurant locations
- `POST /api/scraper/run` - Trigger manual 7shifts data sync
- `POST /api/scraper/historical` - Fetch historical sales data (supports `days` parameter)
- `POST /api/scraper/historical-hourly` - Fetch historical hourly data for week-over-week comparison (body: `{"days": 8}`)
- `GET /api/scraper/status` - View sync status and history

### 7shifts Integration
- **API Client**: Custom REST client in `server/scraper/7shifts-api.ts`
- **Authentication**: Bearer token via `SEVENSHIFTS_API_TOKEN` environment variable
- **Endpoints Used**: `/v2/whoami`, `/v2/company/{id}/locations`, `/v2/reports/daily_sales_and_labor`, `/v2/company/{id}/location/{id}/daily_stats`, `/v2/time_punches`
- **Data Sync**: Fetches actual sales data from 7shifts workforce management platform
- **Sync Interval**: Data updated hourly (7shifts only reports completed hourly intervals)
- **Timezone-Aware Sync**: Server runs in UTC but sync uses Central timezone (America/Chicago) to determine the current date. This ensures that at 9 PM Eastern (8 PM Central), the sync fetches the correct day's data instead of the next day's data. Dates are stored at noon UTC on the target date to avoid DST boundary issues.
- **In-Progress Hour Detection**: Pace charts show a pulsing indicator on the current in-progress hour by scanning cumulative data for the first hour where sales plateau.
- **Historical Seeding**: On startup, automatically loads 8 days of data if missing (for week-over-week comparisons)
- **22 Restaurant Locations**: Athens, Huntsville, Albertville, Hazel Green, Scottsboro, Pell City, Florence, Cullman, Jacksonville, Attalla, Jasper, Gadsden, Owens Cross Roads, Madison County Line, Cumberland Avenue, Turkey Creek, Powell, East Ridge, Shallowford Village, Sevierville, plus Training & Development
- **Known $0 Stores**: East Ridge, Shallowford Village, Sevierville (Tennessee) - likely POS not connected to 7shifts
- **Data Sync Timing**: For complete end-of-day sales, data should be re-synced after midnight when all hourly data is finalized in 7shifts. Real-time syncs during the day only capture completed hours. Some stores (like 1249 - Huntsville) may have hours 22-23 (10pm-midnight) unreported until the next day.
- **Forecast Data Limitation**: 7shifts `daily_stats` API only returns projected_sales for completed hours. For future hours, the system uses last week's actual sales as the forecast estimate since 7shifts doesn't provide future hour forecasts.
- **Labor Forecast**: The leaderboard calculates projected end-of-day labor percentage for each restaurant using a blended approach: (actual labor for completed hours + projected labor for remaining hours) / projected end-of-day sales * 100. This gives the most accurate projection since it uses actual time punch data for hours that have passed. Target labor % is configurable per restaurant via settings (default 25%). Stores show "Making Labor" (green badge) if projected % ≤ target, or "Missing Labor" (red badge) if projected % > target. Uses last week's actuals for remaining hour sales forecast when 7shifts data is unavailable.
- **Time Punches API**: Fetches employee clock-in/clock-out data via `/v2/time_punches` endpoint with `limit=500` to avoid API pagination truncation. Query window: from 4am the day before to **noon the day after** to capture all punches (7shifts interprets query times as UTC, so narrow windows miss evening shifts). Calculates **total labor hours deployed** per hour by summing the fractional hours worked by each employee (e.g., if employee A works 60 min and employee B works 30 min, total = 1.5 hrs). Uses restaurant.timezone from our database (not 7shifts API which returns America/Chicago for all locations). Stored in `hourly_sales.employeeCount` field (legacy name, now contains labor hours as decimal).
- **Labor Deployment Guide**: Uses time punch data to show actual employees on clock vs recommended staffing. Recommended staffing uses a multi-component labor model:
  - **Non-Production Staff**: Fixed hourly positions based on Labor Model 1 (PIC 11am-2pm & 5pm-8pm, Porter 6am-11am, Prep 8am-9am & 4pm-5pm & 11pm-12am, Training 3pm-5pm, DR Attendant 12pm-1:30pm & 5pm-6:30pm, Curbside 10am-2pm & 5pm-9pm). Total: ~19 baseline hours/day.
  - **Production Staff**: Sales-based ramp-up with different charts for Breakfast (6am-11am) vs Non-Breakfast (11am-6am). Breakfast: $0-$118.87=3 staff, scaling to $2,629+=30 staff. Non-Breakfast: $0-$154.53=3 staff, scaling to $3,418+=30 staff.
  - **Total Required = Non-Production + Production**. Status indicator: green if within ±1 employee of target, red if overstaffed, yellow if understaffed.
  - **Early Bird Exclusion**: Hours 0-6 (12am-6am, labeled "Early Bird") are excluded from labor and staffing displays, showing "N/A" instead. This is because overnight labor data from 7shifts isn't meaningful for day-to-day management. The daily staffing totals also exclude these hours.

### Xenial POS Integration (Real-Time Orders)
- **Webhook Endpoint**: `POST /api/xenial/order` - Receives real-time order pushes from Xenial POS
- **Authentication**: Bearer token via `MWBURGER_POS_TOKEN` environment variable
- **Order Data**: Each order includes xenialOrderId, storeNumber, orderTotal, businessDate, orderClosedAt, orderSource
- **Implementation**: `server/xenial-webhook.ts` handles order processing and aggregation
- **Location Mapping**: Xenial store numbers (e.g., "1237") mapped to restaurant IDs via `location_mapping` table

POS API Routes:
- `POST /api/xenial/order` - Webhook endpoint for Xenial to push orders (requires auth token)
- `GET /api/pos/sales` - Get aggregated POS sales by store for a date
- `GET /api/pos/recent` - View recent POS orders (debugging)
- `GET /api/pos/status` - POS webhook status and today's order count
- `POST /api/pos/seed-mappings` - Seed location mappings from Xenial to restaurant IDs

**Xenial Store Number to Restaurant Mapping**:
- 1237 → Athens, 1249 → Huntsville, 1238 → Albertville, 1273 → Hazel Green
- 1350 → Scottsboro, 1351 → Pell City, 1236 → Florence, 1309 → Cullman
- 1492 → Jacksonville, 1491 → Attalla, 1358 → Jasper, 1251 → Gadsden
- Plus: Owens Cross Roads, Madison County Line, Cumberland Avenue, Turkey Creek, Powell, East Ridge, Shallowford Village, Sevierville

### Data Layer
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema Location**: `shared/schema.ts` (shared between frontend and backend)
- **Validation**: Zod schemas via drizzle-zod for type-safe data validation
- **Migrations**: Drizzle Kit with migrations output to `./migrations`

Database Tables:
- `restaurants` - 22 store locations with name, timezone (America/Chicago or America/New_York), and active status
- `daily_sales` - Daily sales snapshots with total sales, vs projected, and labor percent
- `hourly_sales` - Per-hour sales data for timezone-fair comparisons (restaurantId, salesDate, hour 0-23, actualSales, projectedSales, projectedLabor, actualLabor, employeeCount as decimal for labor hours deployed)
- `scraper_runs` - Sync job tracking with status and record counts
- `pos_orders` - Real-time orders received from Xenial POS webhook (xenialOrderId, storeNumber, orderTotal, businessDate, orderClosedAt, orderSource)
- `location_mapping` - Maps Xenial store numbers to restaurant IDs and 7shifts location IDs

### Timezone-Fair Comparison
The leaderboard uses a normalized hour cutoff to ensure fair comparisons between Eastern (America/New_York) and Central (America/Chicago) timezone stores:
- Eastern stores are 1 hour ahead of Central stores
- The normalized hour = (minimum current hour across all timezones) - 1 (last completed hour)
- Sales are summed only for hours 0 through the normalized hour cutoff
- This prevents Eastern stores from having an unfair advantage from their extra hour of sales
- If the normalized hour is -1 (no hours completed), all stores show $0 sales

### Shared Code
The `shared/` directory contains TypeScript types and schemas used by both frontend and backend:
- Database table definitions (Drizzle schemas)
- Insert/select types derived from schemas
- API response interfaces (RestaurantSales with forecastSales, HourlySalesData with forecastSales, LeaderboardData)

### Build System
- **Development**: `tsx` for TypeScript execution, Vite dev server with HMR
- **Production Build**: Custom build script using esbuild for server bundling, Vite for client
- **Output**: Server bundle as `dist/index.cjs`, client assets in `dist/public/`

## External Dependencies

### Database
- **PostgreSQL**: Primary database (connection via `DATABASE_URL` environment variable)
- **Drizzle ORM**: Database operations and schema management
- **connect-pg-simple**: PostgreSQL session store (available but sessions not currently implemented)

### UI Component Libraries
- **Radix UI**: Headless accessible components (dialog, dropdown, tabs, etc.)
- **shadcn/ui**: Styled component system built on Radix primitives
- **Lucide React**: Icon library
- **Recharts**: Charting library for sales visualizations
- **Embla Carousel**: Carousel component
- **cmdk**: Command palette component
- **Vaul**: Drawer component

### Development Tools
- **Vite**: Build tool and dev server
- **Tailwind CSS**: Utility-first CSS framework
- **TypeScript**: Type checking across the codebase
- **Replit plugins**: Runtime error overlay, cartographer, dev banner for Replit environment

### Form & Validation
- **React Hook Form**: Form state management
- **@hookform/resolvers**: Zod resolver for form validation
- **Zod**: Schema validation library