# MWB Unit Ticker - Restaurant Performance Dashboard

## Overview
The MWB Unit Ticker is a restaurant sales performance dashboard providing real-time insights across multiple locations. Its core purpose is to track and compare sales, offer timezone-normalized comparisons, daily sales leaderboards, and hourly sales visualizations. The application aims to enhance operational efficiency by providing clear data on sales trends, holiday impacts, and labor deployment, ultimately supporting data-driven decision-making for restaurant management.

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
- **Component Architecture**: Organizes components into pages, reusable UI components (shadcn/ui), feature-specific components, custom hooks, and utilities.
- **UI/UX Decisions**: Interactive map with red/green markers for performance, holiday context display, settings/admin page for unit management, and badges on leaderboards for quick insights (e.g., drive-thru speed, Google Reviews, OSAT, People Tenure).

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
- **Data Separation Architecture**: Data is segmented into distinct tables (e.g., `pos_orders`, `hourly_sales`, `hourly_labor`, `hme_timer_data`, `daily_weather`) to ensure isolation and multi-app compatibility, allowing independent querying of specific data domains.

### Key Features
- **Map Page**: Interactive map displaying restaurant locations with sales performance indicators and real-time weather data.
- **Holiday Context**: Displays US Federal Holiday information on the dashboard and map.
- **Settings/Admin Page**: Manages restaurant open dates and unit statuses.
- **Sales Display & Ranking**: Uses `actualSales` for consistent ranking and display across deployments, prioritizing POS data for current day sales and falling back to 7shifts for historical data.
- **Daily Performance Summary**: Provides comprehensive daily analysis per unit, including sales variance tracking, staffing pattern analysis, drive-thru speed issue detection, and actionable recommendations. Aggregation occurs at Unit, Market, State, and Company levels.
- **Markets/Grouping System**: Allows creation of custom regional groups for restaurants, enabling filtering and aggregated metrics.
- **7shifts Integration**: Syncs sales, labor, and employee data, performing timezone-aware data normalization and calculating projected labor percentages.
- **Xenial POS Integration**: Receives real-time order data via webhooks as the primary source for current sales, ensuring immediate surfacing of integration issues if data is absent.
- **HME Drive-Thru Timer Integration**: Fetches and aggregates drive-thru timing data from HME CLOUD (ZOOM Nitro), displaying speed indicators on leaderboard cards.
- **Google Reviews Integration**: Tracks Google business review ratings using the Google Places API, with badges indicating performance and a scheduled hourly sync.
- **Qualtrics OSAT Integration**: Collects and processes Qualtrics survey responses via the Imported Data Project (IDP) API to calculate customer satisfaction (OSAT) scores. Surveys are assigned to the correct hour based on transaction time (`d` and `t` fields) for hourly analysis. Features:
  - **Field Mapping**: `s` (store number), `QID1319640445` (satisfaction rating), `d` (transaction date), `t` (transaction time)
  - **Rating Conversion**: Converts text labels ("Extremely satisfied", "Highly satisfied", etc.) to numeric scores (1-5)
  - **Sync Options**: Regular sync (last 3 days) and historical sync (7+ days) from Settings page
  - **Hourly Granularity**: Tracks OSAT by hour to feed into leader metrics and execution grades
  - **Scheduled Sync**: Runs every 5 minutes automatically
- **People Tenure & Performance**: Tracks employee tenure, experience levels, and manager performance based on 7shifts data and time punches. Calculates an "Experience Score" and ranks leaders by average execution grade during their shifts.

## External Dependencies

### Database
- **PostgreSQL**: Primary relational data store.

### UI Component Libraries
- **Radix UI**: Headless UI components.
- **shadcn/ui**: Styled UI components.
- **Lucide React**: Icon library.
- **Recharts**: Charting library.
- **Embla Carousel**: Carousel component.

### Development Tools
- **Vite**: Frontend build tool and development server.
- **Tailwind CSS**: Utility-first CSS framework.
- **TypeScript**: Superset of JavaScript for type safety.
- **Zod**: Schema declaration and validation library.

### APIs/Services
- **7shifts API**: For sales, labor, and employee data synchronization.
- **Open-Meteo API**: For fetching weather data.
- **@18f/us-federal-holidays**: Library for US Federal Holiday data.
- **HME DXS RCD API**: For drive-thru timing data.
- **Google Places API**: For Google business review data.
- **Qualtrics Imported Data Project (IDP) API**: For customer satisfaction survey data from receipt surveys.