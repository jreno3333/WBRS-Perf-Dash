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
- **Endpoints Used**: `/v2/whoami`, `/v2/company/{id}/locations`, `/v2/reports/daily_sales_and_labor`
- **Data Sync**: Fetches actual sales data from 7shifts workforce management platform
- **22 Restaurant Locations**: Athens, Huntsville, Albertville, Hazel Green, Scottsboro, Pell City, Florence, Cullman, Jacksonville, Attalla, Jasper, Gadsden, Owens Cross Roads, Madison County Line, Cumberland Avenue, Turkey Creek, Powell, East Ridge, Shallowford Village, Sevierville, plus Training & Development

### Data Layer
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Schema Location**: `shared/schema.ts` (shared between frontend and backend)
- **Validation**: Zod schemas via drizzle-zod for type-safe data validation
- **Migrations**: Drizzle Kit with migrations output to `./migrations`

Database Tables:
- `restaurants` - 22 store locations with name, timezone (America/Chicago or America/New_York), and active status
- `daily_sales` - Daily sales snapshots with total sales, vs projected, and labor percent
- `hourly_sales` - Per-hour sales data for timezone-fair comparisons (restaurantId, salesDate, hour 0-23, actualSales)
- `scraper_runs` - Sync job tracking with status and record counts

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
- API response interfaces (RestaurantSales, HourlySalesData, LeaderboardData)

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