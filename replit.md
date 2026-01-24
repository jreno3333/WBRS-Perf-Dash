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

### Xenial POS Integration
- **Purpose**: Receives real-time order pushes from Xenial POS - the primary source of sales data.
- **Webhook**: `POST /api/xenial/order` for receiving order data.
- **Data**: Includes order ID, store number, total, business date, closed time, and source.
- **Mapping**: Xenial store numbers are mapped to internal restaurant IDs via `location_mapping` table.
- **Data Priority**: 
  1. Xenial POS hourly data (most accurate - real transactions)
  2. 7shifts hourly data (fallback when no POS data)
  3. 7shifts daily_sales estimates (secondary fallback for week-over-week)
- **Display**: Card shows `actualSales` (total POS transactions so far), ranking uses `actualSales` (normalized for fair timezone comparison).
- **Hourly Chart**: All 24 hours displayed individually with actual POS transaction data per hour.

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