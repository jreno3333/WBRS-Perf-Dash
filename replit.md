# MWB Unit Ticker - Restaurant Performance Dashboard

## Overview
The MWB Unit Ticker is a restaurant sales performance dashboard designed to track and compare sales across multiple locations. Its primary purpose is to provide real-time insights into restaurant performance, including timezone-normalized comparisons, daily sales leaderboards, and hourly sales visualizations. The application aims to enhance operational efficiency by providing clear data on sales trends, holiday impacts, and labor deployment.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query
- **Styling**: Tailwind CSS with shadcn/ui (New York style)
- **Charts**: Recharts (line/area charts)
- **Build Tool**: Vite
- **Component Architecture**: Pages, reusable UI components (shadcn/ui), feature-specific components, custom hooks, and utilities.

### Backend
- **Runtime**: Node.js with Express 5
- **Language**: TypeScript with ES modules
- **API Design**: RESTful JSON endpoints (`/api/`)
- **Development**: Vite middleware for HMR
- **Production**: Static file serving

### Data Layer
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema**: `shared/schema.ts`
- **Validation**: Zod schemas via drizzle-zod
- **Migrations**: Drizzle Kit
- **Data Separation Architecture** (for multi-app compatibility):
  - `pos_orders`: POS transaction data only (Xenial orders) - completely isolated
  - `hourly_sales` / `daily_sales`: Sales data only (7shifts and POS aggregates) - no labor columns
  - `hourly_labor` / `daily_labor`: Labor data only (7shifts time punches, scheduled labor) - separate tables
  - `hme_timer_data`: Drive-thru timing metrics - completely isolated
  - `daily_weather`: Weather data for map display - completely isolated
  - `location_mapping`: Xenial store number to restaurant ID mapping
  - **IMPORTANT**: This separation ensures other apps sharing the database can query `pos_orders` or other tables independently without encountering unrelated data columns. Each data domain (POS, sales, labor, HME, weather) is stored in its own dedicated table(s).

### Key Features
- **Map Page**: Interactive map displaying restaurant locations with sales performance indicators (red/green markers for week-over-week performance), pop-up details, and real-time weather data.
- **Holiday Context**: Displays US Federal Holiday information on the dashboard and map to contextualize sales performance.
- **Settings/Admin Page**: Manages restaurant open dates and unit statuses (Training, New Unit, Established) affecting ranking and display.
- **Sales Display & Ranking**: Uses `actualSales` (sum of all available hourly sales) for both ranking and display. This ensures consistent data between deployments sharing the same database.

### 7shifts Integration
- **Purpose**: Fetches sales data, labor data, and position/role information from 7shifts (fallback for when Xenial POS data is unavailable).
- **Data Sync**: Sales data synced every 5 minutes, timezone-aware (Central timezone for business day determination), and historical data seeding (9 days for week-over-week comparisons).
- **Labor Forecast**: Calculates projected end-of-day labor percentage using actual and projected data.
- **Labor Deployment Guide**: Utilizes time punch data to compare actual employees on clock against a multi-component labor model (non-production and sales-based production staff).
- **Data Format**: 
  - `hourly_sales.actualSales`: Stored in dollars (e.g., 5249.70)
  - `daily_sales.totalSales`: Stored in cents (e.g., 524970 = $5,249.70)
  - Week-over-week fallback divides daily_sales by 100 to normalize
- **Date Normalization**: All timestamps are normalized to noon UTC (e.g., `2026-01-23T12:00:00.000Z`) to prevent timezone-related date shifting in PostgreSQL.
- **Week-over-Week Limitation**: 7shifts daily_stats API only returns hourly intervals for ~3 days. For older dates, the system falls back to daily_sales proportional calculation: `lastWeekSales = dailyTotal × (normalizedHour + 1) / 24`.
- **Labor Data Accuracy**: The system accurately reflects employee clock-in/clock-out data from 7shifts. If afternoon/evening labor counts appear low, this typically indicates:
  1. Day shift employees have clocked out
  2. Evening shift hasn't started punching in yet
  3. Gap between shift changes (normal operations pattern)
  This is accurate data from 7shifts, not a software bug. The time punch query window spans from 4 AM the day before to noon the day after to capture overnight shifts.
- **Timezone-Aware Labor Sync (CRITICAL)**: The `getTimePunches()` function requires a timezone parameter to calculate proper UTC date ranges:
  - Eastern stores (America/New_York): UTC offset = +5 hours
  - Central stores (America/Chicago): UTC offset = +6 hours
  - Query window: `Date.UTC(year, month-1, day, utcOffset-4, 0, 0)` to `Date.UTC(year, month-1, day, utcOffset+23, 59, 59)`
  - Without proper timezone handling, Eastern stores would query the wrong 24-hour UTC window and show incorrect labor data
  - Debug endpoint `/api/debug/fix-labor` can resync historical data for any restaurant/date range

### Xenial POS Integration
- **Purpose**: Receives real-time order pushes from Xenial POS - the primary source of sales data.
- **Webhook**: `POST /api/xenial/order` for receiving order data (via xt-sales-mwb.replit.app).
- **Data**: Includes order ID, store number, total, business date, closed time, and source.
- **Mapping**: Xenial store numbers are mapped to internal restaurant IDs via `location_mapping` table.
- **Data Priority (TODAY)**: 
  - **POS data ONLY** - No 7shifts fallback for current day sales
  - If no POS data exists, sales show as $0 to immediately surface any integration issues
  - This prevents 7shifts early-morning gaps from masking POS problems
- **Data Priority (HISTORICAL)**: 
  1. Xenial POS hourly data (most accurate - real transactions)
  2. 7shifts hourly data (fallback when no POS data)
  3. 7shifts daily_sales estimates (secondary fallback for week-over-week)
- **Display**: Card shows `actualSales` (total POS transactions so far), ranking uses `actualSales` (normalized for fair timezone comparison).
- **Hourly Chart**: All 24 hours displayed individually with actual POS transaction data per hour.
- **Timezone-Aware Partial Hours**: Each restaurant's hourly chart shows data up to its own current hour based on its timezone. Eastern stores (Tennessee) show their current partial hour data, while Central stores (Alabama) show theirs. This ensures all stores display real-time partial sales regardless of timezone.

### HME Drive-Thru Timer Integration
- **Purpose**: Fetches drive-thru timing data from HME CLOUD-connected timers (ZOOM Nitro).
- **API**: HME DXS RCD API (https://api.hmecloud.com)
- **Authentication**: Uses 3 secrets - `HME_SERVICE_ACCOUNT`, `HME_AUTH_KEY`, `HME_ACCOUNT_EMAIL`
- **Data Fetched**:
  - Per-car timing records with detector breakdowns (Menu Board, Greet, Cashier, Service)
  - Total time in lane, queue time, cars in queue
  - Hourly aggregates stored in `hme_timer_data` table
- **API Endpoints**:
  - `POST /api/hme/sync` - Triggers sync of last 6 hours of timer data
  - `GET /api/hme/daily-summary` - Returns daily drive-thru metrics by restaurant
  - `GET /api/hme/metrics/:restaurantId` - Returns hourly timer data for a restaurant
  - `GET /api/hme/stores` - Lists HME stores for validation
- **Display**: Drive-thru speed badge on leaderboard cards showing avg total time with color coding (green <5min, amber 5-7min, red >7min)

### Google Reviews Integration
- **Purpose**: Tracks Google business reviews ratings for each restaurant location.
- **API**: Google Places API (Places Details endpoint)
- **Authentication**: Requires `GOOGLE_PLACES_API_KEY` secret
- **Data Storage**: 
  - `daily_google_reviews` table stores rating snapshots
  - Each restaurant needs `google_place_id` column configured
  - Stores rating (1.0-5.0) and review count
- **Sync Schedule**: Every hour at :00 minutes, end-of-day snapshot at 11 PM Central
- **API Endpoints**:
  - `POST /api/google/sync` - Triggers manual sync of all restaurant reviews
  - `GET /api/google/reviews/:restaurantId` - Returns review data for a restaurant
- **Display**: Star badge on leaderboard cards with color coding:
  - Green: 4.5+ rating (excellent)
  - Blue: 4.0-4.4 rating (good)
  - Amber: 3.5-3.9 rating (needs attention)
  - Red: Below 3.5 (critical)
- **Tooltip**: Shows total review count on hover
- **Future**: Rating may be integrated into X-Score calculation

### People Tenure & Performance (formerly Crew Experience)
- **Purpose**: Tracks employee tenure, experience levels, and manager/supervisor performance.
- **Route**: `/crew` page
- **Data Source**: 7shifts employee data and time punches
- **Employee Positions**: 
  - `employees.position` column stores role (Manager, Shift Supervisor, Team Member, etc.)
  - Positions are synced from 7shifts time punches during crew sync
- **Tenure Categories**:
  - Training (T): < 90 days, score 25
  - Developing (D): 90 days - 6 months, score 50
  - Experienced (E): 6 months - 1 year, score 75
  - Veteran (V): 1+ year, score 100
- **Experience Score**: Weighted average of crew tenure (0-100 scale)
- **Leader Performance**:
  - Tracks managers and shift supervisors
  - Ranks by average execution grade during hours they worked
  - Displays company-wide top 10 and best performer per store
  - **Execution Grade Calculation**:
    - Sales component: 100 if within 5% of last week, 50 if below
    - Staffing component: 100 if properly staffed, 70 if overstaffed, 60 if understaffed
    - **Sales Surge Exception**: No understaffing penalty when hourly sales are 20%+ above last week (recognizes unexpected rushes)
- **Data Storage**: 
  - `employees` table stores hire_date, invited_at, and position
  - `hourly_crew` table stores hourly crew composition and scores
- **Sync Schedule**: Every hour at :00 minutes (first 5 minutes of the hour)
- **API Endpoints**:
  - `POST /api/crew/sync-employees` - Syncs employee data from 7shifts
  - `POST /api/crew/sync` - Recalculates hourly crew experience for a date (also updates employee positions)
  - `GET /api/crew/experience` - Returns hourly crew breakdown by restaurant
  - `GET /api/crew/summary` - Returns daily average scores for leaderboard
  - `GET /api/people/performance` - Returns manager/supervisor performance rankings
- **Display**: 
  - GraduationCap icon badge on leaderboard cards with score
  - Color coding: green (≥75), amber (≥50), red (<50)
  - Hourly tooltips show V/E/D/T breakdown
  - Tabbed People Tenure & Performance page:
    - **Leader Rankings tab**: Company top performers and top by store
    - **Hourly Tenure tab**: Detailed hourly team composition

## External Dependencies

### Database
- **PostgreSQL**: Primary data store.
- **Drizzle ORM**: For database interactions.

### UI Component Libraries
- **Radix UI**: Headless components.
- **shadcn/ui**: Styled components.
- **Lucide React**: Icons.
- **Recharts**: Charting.
- **Embla Carousel**: Carousel functionality.

### Development Tools
- **Vite**: Build tool and dev server.
- **Tailwind CSS**: Styling framework.
- **TypeScript**: Language.
- **Zod**: Schema validation.

### APIs/Services
- **7shifts API**: For sales, labor, and employee data.
- **Open-Meteo API**: For weather data on the map page.
- **@18f/us-federal-holidays**: For US Federal Holiday data.