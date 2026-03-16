# MWB Unit Ticker - Restaurant Performance Dashboard

## Overview
The MWB Unit Ticker is a real-time restaurant sales performance dashboard designed to enhance operational efficiency. It provides insights across multiple locations by tracking and comparing sales, offering timezone-normalized comparisons, daily sales leaderboards, and hourly sales visualizations. The application supports data-driven decision-making by clarifying sales trends, holiday impacts, and labor deployment. Key capabilities include daily performance summaries, market-level aggregations, historical performance analysis, and year-over-year sales comparisons.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Framework**: React 18 with TypeScript
- **Routing**: Wouter
- **State Management**: TanStack React Query
- **Styling**: Tailwind CSS with shadcn/ui (New York style)
- **Charts**: Recharts
- **Build Tool**: Vite
- **UI/UX Decisions**: Interactive map with performance indicators, holiday context display, settings/admin page for unit management, and badges on leaderboards for metrics like drive-thru speed, Google Reviews, OSAT, and People Tenure.

### Backend
- **Runtime**: Node.js with Express 5
- **Language**: TypeScript with ES modules
- **API Design**: RESTful JSON endpoints

### Data Layer
- **ORM**: Drizzle ORM with PostgreSQL dialect
- **Validation**: Zod schemas
- **Migrations**: Drizzle Kit
- **Data Architecture**: Segmented tables for `pos_orders`, `hourly_sales`, `hourly_labor`, `hme_timer_data`, `daily_weather` to ensure isolation and multi-app compatibility.
- **Labor Data**: Tracks `hourly_labor.employee_count` (fractional hours) and `hourly_crew.crew_count` (unique individuals) separately.
- **Data Retention**: All data is retained for 2 years (730 days) with daily automatic cleanup.

### Key Features
- **Sales & Performance**: Displays sales ranking, daily performance summaries with variance tracking, staffing analysis, and drive-thru issue detection. Aggregation occurs at Unit, Market, State, and Company levels.
- **Holiday Context**: Integrates US Federal Holiday information.
- **Unit Management**: Settings/Admin page for managing restaurant open dates and statuses.
- **Weighted Execution Grading System**: Grades units based on a weighted formula including Sales (35%), Speed (25%), OSAT (25%), and Staffing (15%), normalized for available data.
- **People Tenure & Performance**: Tracks employee tenure and ranks leaders by average execution grade and average hourly sales volume during their shifts, with eligibility criteria based on hours worked and survey responses.
- **Performance History**: Displays historical performance trends over configurable date ranges (7/14/30/60/90/180 days) with company, state, and market summaries, daily grade timelines, and detailed metrics.
- **Weekly Sales Trends**: Tracks Saturday-Friday business week totals at company, state, market, and unit levels with prior week comparison (via `/api/weekly-sales` endpoint).
- **Sales Variance**: Calculates sales variance against historical data from 7 days prior. Both `actualSales` and `actualLastWeekSales` use the same `restaurantCompletedHour` window (local timezone current hour - 1) to ensure apples-to-apples comparison. The in-progress hour is excluded from both sides.
- **Same Store Sales (SSS)**: Company-level sales only count units open over 18 months, with a filter for SSS-eligible stores.
- **Forecast Eligibility**: All active (non-training) units are included in company-level forecast/projected rollups immediately. New units without prior-week data contribute their actual sales to projections.
- **Year-over-Year (YoY) Sales Comparison**: Allows upload of historical daily sales CSVs for YoY comparisons, matching the same day of the week from the prior year. Displays projected YoY for individual units and aggregated SSS YoY.

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
- **Vite**: Frontend build tool.
- **Tailwind CSS**: Utility-first CSS framework.
- **TypeScript**: For type safety.
- **Zod**: Schema validation.

### Authentication
- **Magic Link Email Auth**: User authentication via magic links sent to email, with sessions backed by PostgreSQL.
- **Resend API**: For sending authentication and daily report emails.

### APIs/Services
- **7shifts API**: Sales, labor, and employee data synchronization.
- **Open-Meteo API**: Weather data.
- **@18f/us-federal-holidays**: US Federal Holiday data.
- **HME DXS RCD API**: Drive-thru timing data.
- **Google Places API**: Google business review data.
- **Qualtrics Imported Data Project (IDP) API**: Customer satisfaction survey data.

### Other Integrations
- **Xenial POS**: Real-time order data via webhooks (sole source for sales data).