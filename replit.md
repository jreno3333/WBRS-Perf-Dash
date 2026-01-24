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

### Key Features
- **Map Page**: Interactive map displaying restaurant locations with sales performance indicators (red/green markers for week-over-week performance), pop-up details, and real-time weather data.
- **Holiday Context**: Displays US Federal Holiday information on the dashboard and map to contextualize sales performance.
- **Settings/Admin Page**: Manages restaurant open dates and unit statuses (Training, New Unit, Established) affecting ranking and display.
- **Sales Display & Ranking**: Uses `todaySales` (normalized, timezone-fair) for ranking and `actualSales` (sum of all available hourly sales) for display to ensure fair comparisons while matching 7shifts totals.

### 7shifts Integration
- **Purpose**: Fetches sales data, labor data, and position/role information from 7shifts (fallback for when Xenial POS data is unavailable).
- **Data Sync**: Sales data synced every 5 minutes, timezone-aware (Central timezone for business day determination), and historical data seeding (9 days for week-over-week comparisons).
- **Labor Forecast**: Calculates projected end-of-day labor percentage using actual and projected data.
- **Labor Deployment Guide**: Utilizes time punch data to compare actual employees on clock against a multi-component labor model (non-production and sales-based production staff).

### Xenial POS Integration
- **Purpose**: Receives real-time order pushes from Xenial POS.
- **Webhook**: `POST /api/xenial/order` for receiving order data.
- **Data**: Includes order ID, store number, total, business date, closed time, and source.
- **Mapping**: Xenial store numbers are mapped to internal restaurant IDs.

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