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
- **Labor vs Crew Data**: Two distinct metrics tracked separately:
  - `hourly_labor.employee_count`: Fractional labor hours worked during the hour (e.g., 9.5 means 9.5 total hours worked)
  - `hourly_crew.crew_count` + `tenure_mix`: Unique individuals clocked in during the hour (headcount)
  - These differ during shift changes when employees work partial hours (e.g., 13 people may contribute only 9.5 total hours)

### Key Features
- **Map Page**: Interactive map displaying restaurant locations with sales performance indicators and real-time weather data.
- **Holiday Context**: Displays US Federal Holiday information on the dashboard and map.
- **Settings/Admin Page**: Manages restaurant open dates and unit statuses.
- **Sales Display & Ranking**: Uses `actualSales` for consistent ranking and display across deployments, sourced exclusively from Xenial POS data stored in pos_orders table.
- **Daily Performance Summary**: Provides comprehensive daily analysis per unit, including sales variance tracking, staffing pattern analysis, drive-thru speed issue detection, and actionable recommendations. Aggregation occurs at Unit, Market, State, and Company levels.
- **Markets/Grouping System**: Allows creation of custom regional groups for restaurants, enabling filtering and aggregated metrics.
- **7shifts Integration**: Syncs sales, labor, and employee data, performing timezone-aware data normalization and calculating projected labor percentages.
- **Xenial POS Integration**: Receives real-time order data via webhooks as the sole source for sales data. Hourly sales sync writes complete records (POS sales + 7shifts labor) every 5 minutes. 7shifts is only used for labor/projected data — never for actual sales (same POS source with added delay). Historical sales data is retained in our own database, eliminating any dependency on 7shifts for sales.
- **HME Drive-Thru Timer Integration**: Fetches and aggregates drive-thru timing data from HME CLOUD (ZOOM Nitro). Displays **speed attainment** (% of cars served under 6 minutes) rather than average service time. The `hme_timer_data` table stores `cars_under_6_min` for each hourly record. Speed attainment = (cars under 6 min / total cars) x 100. Color-coded: green >=70%, yellow >=50%, red <50%.
- **Google Reviews Integration**: Tracks Google business review ratings using the Google Places API, with badges indicating performance and a scheduled hourly sync.
- **Qualtrics OSAT Integration**: Collects and processes Qualtrics survey responses via the Imported Data Project (IDP) API to calculate customer satisfaction (OSAT) scores. Surveys are assigned to the correct hour based on transaction time (`d` and `t` fields) for hourly analysis. Features:
  - **Field Mapping**: `s` (store number), `QID1319640445` (satisfaction rating), `d` (transaction date), `t` (transaction time)
  - **Category Rating Fields**: Tracks specific satisfaction areas from surveys:
    - `QID1319640443_3` (Order Accuracy), `QID1319640443_8` (Food Quality), `QID1319640443_1` (Menu Options)
    - `QID1319640443_9` (Value), `QID1319640443_2` (Ease of Ordering), `QID1319640443_11` (Employee Friendliness)
    - `QID1319640443_10` (Speed of Service), `QID1319640443_12` (Cleanliness), `QID1319640443_14` (Drive-Thru Wait Time)
  - **Survey Issue Areas**: Displays categories rated less than 3/5 in the Daily Summary for coaching focus
  - **Rating Conversion**: Converts text labels ("Extremely satisfied", "Highly satisfied", etc.) to numeric scores (1-5)
  - **Sync Options**: Regular sync (last 3 days) and historical sync (7+ days) from Settings page
  - **Hourly Granularity**: Tracks OSAT by hour and displays in hourly chart tooltips (green 85%+, yellow 80-85%, red <80%)
  - **Hourly Chart Display**: Green OSAT legend indicator; tooltip shows "OSAT X% (N)" where N is response count
  - **Scheduled Sync**: Runs every 5 minutes automatically
  - **Summary Cards Display**: Shows aggregate OSAT percentage and response count with color-coded badge (green for 85%+, yellow for 80-85%, red for <80%)
  - **Daily Summary Display**: OSAT badge on unit cards, OSAT issues section (hours with <80% OSAT), survey issue areas for coaching, and OSAT in strengths/concerns with recommendations
  - **Surveys Received Section**: Shows each hour with surveys, color-coded satisfaction badges, response count, and the leader(s) on duty for recognition/coaching
  - **Aggregated Views**: State/Market summary cards show aggregate OSAT metrics and count of units with low OSAT
- **Weighted Execution Grading System**: All execution grades use a weighted formula with normalization:
  - **Sales**: 35% weight (100 points if variance >= -5%, 50 points if below)
  - **Speed**: 25% weight (100 points if attainment >= 70%, 70 if >= 50%, 40 if < 50%) - only if drive-thru data available
  - **OSAT**: 25% weight (100 points if >= 85%, 70 if >= 80%, 40 if < 80%) - only if customer satisfaction data available
  - **Staffing**: 15% weight (100 points if within ±1, 60 if outside range) - only if valid staffing data available
  - Weights are normalized based on available components, so a restaurant without OSAT data is graded fairly against its available metrics
- **People Tenure & Performance**: Tracks employee tenure, experience levels, and manager/supervisor performance (never Team Members) based on 7shifts data and time punches. Calculates an "Experience Score" and ranks leaders by average execution grade during their shifts. Includes average hourly sales volume ($/hr) per leader compared to company average (weighted by hours worked), classified as Low (<75%), Med (75-125%), or High (>125%) to provide volume context for performance grades. Leader eligibility scales by time period:
  - 7 days: min 30 hours + 2 survey responses
  - 14 days: min 40 hours + 4 survey responses
  - 30 days: min 60 hours + 8 survey responses
  - 60 days: min 100 hours + 14 survey responses
  - 90 days: min 140 hours + 20 survey responses
  - 180 days: min 200 hours + 30 survey responses
- **Performance History**: Displays historical performance trends over configurable date ranges (7/14/30 days) at /history. Features:
  - Date range selector for viewing different time periods (uses last N days with actual data, not calendar days)
  - State and market filters for focused analysis
  - Company, state, and market summary cards showing aggregate grades
  - Expandable restaurant cards with daily grade timelines (shows all 7/14/30 days)
  - Six metrics in expanded view: Avg Grade, Total Sales, Avg Speed Attainment (%), OSAT, Avg XP, Grade Trend
  - Grade calculation aligned with dashboard logic including hasComparableSales, isFirstWeek handling, and sales surge exception
  - Speed metrics from HME timer data as attainment % (color-coded: green >=70%, yellow >=50%, red <50%)
  - OSAT from Qualtrics surveys
  - XP (experience score) from hourly_crew data (color-coded: green 85+, yellow 70-84, orange 50-69, red <50)
  - Grade Trend shows improvement comparing second half to first half of the date range
  - Note: Server-side staffing calculation uses labor cost variance as proxy (differs slightly from client headcount-based labor model)
- **Grade Scale (Detailed)**: Unified across dashboard and Performance History
  - A+ = 95+, A = 90-94, A- = 85-89, B+ = 80-84, B = 75-79, B- = 70-74
  - C+ = 65-69, C = 60-64, C- = 55-59, D = 50-54, F = below 50
- **Sales Variance Data**: Sales variance is calculated by comparing current day sales to our own historical data from 7 days ago (not relying on 7shifts pastActualSales). This ensures accurate week-over-week comparisons using our database records.
- **Year-over-Year (YoY) Sales Comparison**: Upload historical daily sales CSV data for year-over-year comparisons. Features:
  - **CSV Upload**: Settings page allows uploading CSV files with format: Location, Date, Net Sales, Guest Count
  - **Historical Data Table**: `historical_daily_sales` stores uploaded data with restaurant_id + date uniqueness
  - **Day-of-Week Matching**: YoY comparisons match the same day of the week (not calendar date) from the prior year
  - **Dashboard Display**: Blue/orange YoY badges on each restaurant card and company-level YoY variance in summary cards
  - **Bulk API**: `/api/historical-sales/yoy-bulk?date=YYYY-MM-DD` returns prior year data for all restaurants at once
  - **Data Management**: Upload new CSV data (upserts on conflict), view summary stats, or clear all data from Settings
- **Data Retention Policy**: All data (sales, labor, HME timer, OSAT, crew, POS orders, Google reviews) is retained for 2 years (730 days). Automatic cleanup runs daily at midnight to remove data older than the retention period.

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

### Authentication
- **Magic Link Email Auth**: Users sign in by entering their email on `/login`. A magic link is sent via Resend (or logged to console if no API key). Token is SHA256-hashed, single-use, expires in 15 minutes. Sessions last 30 days (PostgreSQL-backed via connect-pg-simple).
- **Auth Middleware**: Protects all `/api/*` routes except `/api/auth/`, `/api/diagnostics`, `/api/db-status`, `/api/xenial/` (webhooks).
- **Allowed Emails**: Optional `ALLOWED_LOGIN_EMAILS` env var (comma-separated). If not set, any email can log in.
- **Auth Files**: `server/routes.ts` (auth endpoints), `client/src/pages/login.tsx` (login UI), `client/src/App.tsx` (AuthGuard wrapper).

### Daily Report Emails
- **Scheduler**: Sends daily performance summary and leader ranking emails at configurable times (Central Time) using `server/scheduler.ts`, `server/daily-report.ts`, and `server/leader-report.ts`. Default: 6:00 AM Central for both reports. Configurable via Settings page using `report_schedules` table.
- **Report Schedule Config**: `report_schedules` table stores `report_type` (daily_report/leader_report), `send_hour`, `send_minute`, `is_enabled`. API: GET/PATCH `/api/report-schedules`.
- **Subscribers**: Managed in Settings page (`/settings`). Supports name, email, active/paused status.
- **Deduplication**: Uses `email_send_log` table to prevent duplicate sends per report date.
- **Email Service**: `server/email.ts` wraps Resend API. Requires `RESEND_API_KEY` secret. Uses `RESEND_FROM_EMAIL` or defaults to `onboarding@resend.dev`.

### APIs/Services
- **7shifts API**: For sales, labor, and employee data synchronization.
- **Open-Meteo API**: For fetching weather data.
- **@18f/us-federal-holidays**: Library for US Federal Holiday data.
- **HME DXS RCD API**: For drive-thru timing data.
- **Google Places API**: For Google business review data.
- **Qualtrics Imported Data Project (IDP) API**: For customer satisfaction survey data from receipt surveys.
- **Resend API**: For sending magic link authentication emails and daily performance report emails.