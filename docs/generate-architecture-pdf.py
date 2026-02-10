#!/usr/bin/env python3
"""
Generate Architecture Reference PDF with visual database diagrams and API maps.
Uses fpdf2 for PDF generation with drawn diagrams.
"""

import sys
# Workaround: fpdf2 optionally imports cryptography which has a broken cffi backend
# in this environment. We stub it out since we don't need PDF encryption.
import types
_fake = types.ModuleType('cryptography')
_fake.hazmat = types.ModuleType('cryptography.hazmat')
sys.modules.setdefault('cryptography', _fake)
sys.modules.setdefault('cryptography.hazmat', _fake.hazmat)

from fpdf import FPDF
import os

# ── Color palette ──────────────────────────────────────────────
C_PRIMARY   = (41, 65, 122)    # Dark blue
C_SECONDARY = (66, 103, 178)   # Medium blue
C_ACCENT    = (234, 88, 12)    # Orange
C_SUCCESS   = (22, 163, 74)    # Green
C_WARN      = (202, 138, 4)    # Amber
C_GRAY      = (107, 114, 128)  # Gray text
C_LIGHT_BG  = (241, 245, 249)  # Light slate bg
C_WHITE     = (255, 255, 255)
C_BLACK     = (30, 30, 30)
C_TABLE_HDR = (51, 65, 85)     # Slate 700
C_TABLE_ROW = (248, 250, 252)  # Slate 50
C_BORDER    = (203, 213, 225)  # Slate 300

# Entity colors for diagrams
C_ENT_CORE     = (59, 130, 246)   # Blue - core tables
C_ENT_LABOR    = (139, 92, 246)   # Purple - labor/7shifts
C_ENT_POS      = (234, 88, 12)    # Orange - POS
C_ENT_QUALITY  = (22, 163, 74)    # Green - quality/OSAT
C_ENT_ENRICH   = (6, 182, 212)    # Cyan - enrichment
C_ENT_ARENA    = (236, 72, 153)   # Pink - gamification
C_ENT_HIRING   = (245, 158, 11)   # Amber - hiring
C_ENT_AUTH     = (107, 114, 128)  # Gray - auth/config


class ArchPDF(FPDF):
    def __init__(self):
        super().__init__(orientation='P', unit='mm', format='A4')
        self.set_auto_page_break(auto=True, margin=20)
        self.page_num = 0

    def header(self):
        if self.page_no() == 1:
            return  # Custom cover page
        self.set_font("Helvetica", "B", 8)
        self.set_text_color(*C_GRAY)
        self.cell(0, 6, "WBRS Performance Dashboard - Architecture Reference", align="L")
        self.ln(2)
        self.set_draw_color(*C_BORDER)
        self.line(10, 14, 200, 14)
        self.ln(6)

    def footer(self):
        if self.page_no() == 1:
            return
        self.set_y(-15)
        self.set_font("Helvetica", "", 7)
        self.set_text_color(*C_GRAY)
        self.cell(0, 10, f"Page {self.page_no() - 1}", align="C")

    # ── Drawing helpers ────────────────────────────────────────

    def section_title(self, num, title):
        self.set_font("Helvetica", "B", 16)
        self.set_text_color(*C_PRIMARY)
        self.cell(0, 10, f"{num}. {title}", ln=True)
        self.set_draw_color(*C_ACCENT)
        self.set_line_width(0.6)
        y = self.get_y()
        self.line(10, y, 80, y)
        self.set_line_width(0.2)
        self.ln(4)

    def sub_title(self, title):
        self.set_font("Helvetica", "B", 12)
        self.set_text_color(*C_SECONDARY)
        self.cell(0, 8, title, ln=True)
        self.ln(2)

    def body_text(self, text):
        self.set_font("Helvetica", "", 9)
        self.set_text_color(*C_BLACK)
        self.multi_cell(0, 5, text)
        self.ln(2)

    def bold_text(self, text):
        self.set_font("Helvetica", "B", 9)
        self.set_text_color(*C_BLACK)
        self.multi_cell(0, 5, text)
        self.ln(1)

    def code_block(self, text):
        self.set_font("Courier", "", 8)
        self.set_fill_color(*C_LIGHT_BG)
        self.set_text_color(*C_BLACK)
        x = self.get_x()
        y = self.get_y()
        lines = text.strip().split('\n')
        h = len(lines) * 4.5 + 4
        self.rect(x, y, 190, h, 'F')
        self.set_xy(x + 3, y + 2)
        for line in lines:
            self.cell(0, 4.5, line, ln=True)
            self.set_x(x + 3)
        self.ln(3)

    def draw_box(self, x, y, w, h, label, color, sublabel=None, font_size=8):
        self.set_fill_color(*color)
        self.set_draw_color(max(0, color[0]-40), max(0, color[1]-40), max(0, color[2]-40))
        self.rect(x, y, w, h, 'DF')
        self.set_font("Helvetica", "B", font_size)
        self.set_text_color(*C_WHITE)
        text_y = y + h/2 - 2 if sublabel else y + h/2 - 1.5
        self.set_xy(x, text_y)
        self.cell(w, 4, label, align="C")
        if sublabel:
            self.set_font("Helvetica", "", 6)
            self.set_xy(x, text_y + 4)
            self.cell(w, 3, sublabel, align="C")

    def draw_arrow(self, x1, y1, x2, y2, color=C_GRAY, dashed=False):
        self.set_draw_color(*color)
        self.set_line_width(0.4)
        if dashed:
            # draw dashed line manually
            dx = x2 - x1
            dy = y2 - y1
            length = (dx**2 + dy**2) ** 0.5
            if length == 0:
                return
            segments = int(length / 3)
            for i in range(0, segments, 2):
                t1 = i / segments
                t2 = min((i + 1) / segments, 1.0)
                sx = x1 + dx * t1
                sy = y1 + dy * t1
                ex = x1 + dx * t2
                ey = y1 + dy * t2
                self.line(sx, sy, ex, ey)
        else:
            self.line(x1, y1, x2, y2)
        # arrowhead
        import math
        angle = math.atan2(y2 - y1, x2 - x1)
        arrow_len = 2
        a1 = angle + math.pi * 0.85
        a2 = angle - math.pi * 0.85
        self.line(x2, y2, x2 + arrow_len * math.cos(a1), y2 + arrow_len * math.sin(a1))
        self.line(x2, y2, x2 + arrow_len * math.cos(a2), y2 + arrow_len * math.sin(a2))
        self.set_line_width(0.2)

    def draw_table(self, headers, rows, col_widths=None):
        if col_widths is None:
            col_widths = [190 / len(headers)] * len(headers)

        # Header
        self.set_font("Helvetica", "B", 7.5)
        self.set_fill_color(*C_TABLE_HDR)
        self.set_text_color(*C_WHITE)
        x_start = self.get_x()
        for i, hdr in enumerate(headers):
            self.cell(col_widths[i], 7, hdr, border=1, align="C", fill=True)
        self.ln()

        # Rows
        self.set_font("Helvetica", "", 7.5)
        for ri, row in enumerate(rows):
            if ri % 2 == 0:
                self.set_fill_color(*C_TABLE_ROW)
            else:
                self.set_fill_color(*C_WHITE)
            self.set_text_color(*C_BLACK)
            self.set_x(x_start)
            max_h = 7
            # Calculate needed height
            for i, cell_text in enumerate(row):
                lines_needed = max(1, len(str(cell_text)) * 1.8 / col_widths[i])
                if lines_needed > 1.5:
                    max_h = 11
            for i, cell_text in enumerate(row):
                self.cell(col_widths[i], max_h, str(cell_text), border=1, fill=True)
            self.ln()
        self.ln(3)

    def draw_legend_item(self, x, y, color, label):
        self.set_fill_color(*color)
        self.rect(x, y, 4, 4, 'F')
        self.set_font("Helvetica", "", 7)
        self.set_text_color(*C_BLACK)
        self.set_xy(x + 5, y - 0.5)
        self.cell(40, 5, label)


def build_pdf():
    pdf = ArchPDF()

    # ═══════════════════════════════════════════════════════════
    # COVER PAGE
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.set_fill_color(*C_PRIMARY)
    pdf.rect(0, 0, 210, 297, 'F')

    # Accent bar
    pdf.set_fill_color(*C_ACCENT)
    pdf.rect(0, 80, 210, 4, 'F')

    # Title
    pdf.set_font("Helvetica", "B", 32)
    pdf.set_text_color(*C_WHITE)
    pdf.set_xy(20, 100)
    pdf.cell(170, 15, "Architecture Reference", align="C")

    pdf.set_font("Helvetica", "", 16)
    pdf.set_xy(20, 118)
    pdf.cell(170, 10, "WBRS Performance Dashboard", align="C")

    # Subtitle
    pdf.set_font("Helvetica", "", 11)
    pdf.set_text_color(180, 200, 230)
    pdf.set_xy(20, 138)
    pdf.multi_cell(170, 6, (
        "System integrations, database structures, API dependencies,\n"
        "and module roadmap for the operational back-office platform"
    ), align="C")

    # Metadata
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(150, 170, 200)
    pdf.set_xy(20, 200)
    pdf.cell(170, 6, "Data Sources: 7shifts  |  Xenial POS  |  HME Cloud  |  Qualtrics  |  Google Places", align="C")
    pdf.set_xy(20, 208)
    pdf.cell(170, 6, "Future Modules: Training  |  Inventory  |  User Provisioning  |  CRM  |  Payroll  |  Analytics", align="C")

    pdf.set_xy(20, 260)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(120, 140, 170)
    pdf.cell(170, 6, "February 2026  |  Internal Reference Document", align="C")

    # ═══════════════════════════════════════════════════════════
    # TABLE OF CONTENTS
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(*C_PRIMARY)
    pdf.cell(0, 12, "Table of Contents", ln=True)
    pdf.ln(4)

    toc = [
        ("1", "System Architecture Overview"),
        ("2", "External Integration Map"),
        ("3", "Database Structure & Entity Relationships"),
        ("4", "Cross-System Identity Linking"),
        ("5", "7shifts API Deep Dive"),
        ("6", "Sync Pipeline & Data Flow"),
        ("7", "Replacing 7shifts - Migration Playbook"),
        ("8", "Module Roadmap & Future Integrations"),
        ("9", "Environment Variables Reference"),
    ]
    for num, title in toc:
        pdf.set_font("Helvetica", "B", 11)
        pdf.set_text_color(*C_SECONDARY)
        pdf.cell(10, 8, num + ".")
        pdf.set_font("Helvetica", "", 11)
        pdf.set_text_color(*C_BLACK)
        pdf.cell(0, 8, title, ln=True)
    pdf.ln(6)

    # ═══════════════════════════════════════════════════════════
    # SECTION 1: SYSTEM ARCHITECTURE OVERVIEW
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("1", "System Architecture Overview")

    pdf.body_text(
        "The WBRS Performance Dashboard is a full-stack TypeScript monorepo that aggregates real-time data "
        "from multiple external sources into a unified restaurant performance platform. The backend (Express 5) "
        "syncs data every 5 minutes, stores it in PostgreSQL via Drizzle ORM, and serves normalized APIs. "
        "The frontend (React 18 + Vite) consumes these APIs through React Query."
    )

    pdf.sub_title("High-Level Architecture Diagram")

    # Draw the architecture diagram
    y_start = pdf.get_y() + 2

    # Background
    pdf.set_fill_color(*C_LIGHT_BG)
    pdf.rect(10, y_start, 190, 95, 'F')
    pdf.set_draw_color(*C_BORDER)
    pdf.rect(10, y_start, 190, 95, 'D')

    # Core platform boxes
    pdf.draw_box(18, y_start + 8, 38, 14, "React Frontend", C_ENT_CORE, "Vite + React Query")
    pdf.draw_box(62, y_start + 8, 38, 14, "Express API", C_ENT_CORE, "REST + WebSocket")
    pdf.draw_box(106, y_start + 8, 38, 14, "PostgreSQL", C_ENT_CORE, "Drizzle ORM")
    pdf.draw_box(150, y_start + 8, 42, 14, "Scheduler", C_SECONDARY, "5-min polling")

    # Arrows between core
    pdf.draw_arrow(56, y_start + 15, 62, y_start + 15, C_PRIMARY)
    pdf.draw_arrow(100, y_start + 15, 106, y_start + 15, C_PRIMARY)
    pdf.draw_arrow(150, y_start + 15, 144, y_start + 15, C_PRIMARY)

    # External sources row
    ext_y = y_start + 38
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(*C_GRAY)
    pdf.set_xy(14, ext_y - 6)
    pdf.cell(60, 4, "External Data Sources")

    sources = [
        ("7shifts", C_ENT_LABOR, "Labor/Sales"),
        ("Xenial POS", C_ENT_POS, "Transactions"),
        ("HME Cloud", C_ENT_ENRICH, "Drive-Thru"),
        ("Qualtrics", C_ENT_QUALITY, "OSAT Surveys"),
        ("Google", C_ENT_QUALITY, "Reviews"),
        ("Workstream", C_ENT_HIRING, "Hiring"),
        ("Weather", C_ENT_ENRICH, "Open-Meteo"),
    ]

    x_pos = 14
    for name, color, sub in sources:
        w = 25
        pdf.draw_box(x_pos, ext_y, w, 12, name, color, sub, font_size=7)
        # Arrow up to API
        center_x = x_pos + w/2
        pdf.draw_arrow(center_x, ext_y, 81, y_start + 22, C_GRAY, dashed=True)
        x_pos += 26

    # Outbound services
    out_y = y_start + 64
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(*C_GRAY)
    pdf.set_xy(14, out_y - 6)
    pdf.cell(60, 4, "Outbound Services")

    pdf.draw_box(14, out_y, 30, 12, "Resend", C_ENT_AUTH, "Email/Reports", font_size=7)
    pdf.draw_box(48, out_y, 36, 12, "Magic Link", C_ENT_AUTH, "Auth (Passwordless)", font_size=7)
    pdf.draw_box(88, out_y, 36, 12, "Daily Reports", C_SECONDARY, "6 AM Central", font_size=7)
    pdf.draw_box(128, out_y, 36, 12, "Arena Engine", C_ENT_ARENA, "Gamification", font_size=7)

    pdf.set_y(y_start + 100)
    pdf.ln(2)

    pdf.bold_text("Technology Stack:")
    pdf.body_text(
        "Backend: Express 5, TypeScript, Drizzle ORM, PostgreSQL, Passport (session auth)\n"
        "Frontend: React 18, Vite, TanStack React Query, Recharts, Radix UI, Tailwind CSS\n"
        "Hosting: Replit  |  Email: Resend  |  Auth: Passwordless magic-link"
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 2: EXTERNAL INTEGRATION MAP
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("2", "External Integration Map")

    pdf.body_text(
        "Each external system connects via a specific method (REST API polling, webhook, or file export). "
        "All data is normalized into the internal PostgreSQL schema before the frontend consumes it."
    )

    pdf.draw_table(
        ["Integration", "Role", "Sync Method", "Frequency", "Auth Method"],
        [
            ["7shifts", "Labor mgmt, sales forecasts", "REST API v2 (poll)", "Every 5 min", "Bearer token"],
            ["Xenial POS", "Real-time transactions", "Inbound webhook", "Real-time", "Open (no auth)"],
            ["HME Cloud", "Drive-thru timers", "REST API (poll)", "Every 5 min", "Service acct + key"],
            ["Qualtrics", "Customer satisfaction", "IDP export + CSV", "Every 5 min", "API token"],
            ["Google Places", "Review ratings", "REST API (poll)", "Hourly", "API key"],
            ["Workstream", "Hiring pipeline", "REST API", "On-demand", "API token"],
            ["Open-Meteo", "Weather data", "REST API", "Hourly + EOD", "None (public)"],
            ["Resend", "Transactional email", "REST API", "On-demand", "API key"],
        ],
        [28, 42, 34, 28, 30]
    )

    pdf.sub_title("Data Volume & Priority")
    pdf.draw_table(
        ["Source", "Rows/Day (est.)", "Tables Written", "Business Priority"],
        [
            ["7shifts", "~400 hourly + 22 daily", "dailySales, dailyLabor, hourlySales, hourlyLabor, hourlyCrew, employees", "CRITICAL"],
            ["Xenial POS", "~5,000-10,000 orders", "posOrders (overlaid on hourlySales)", "CRITICAL"],
            ["HME Cloud", "~400 hourly", "hmeTimerData", "HIGH"],
            ["Qualtrics", "~100-300 responses/day", "osatData, dailyOsat, osatCategoryIssues", "HIGH"],
            ["Google Places", "22 daily", "dailyGoogleReviews", "MEDIUM"],
            ["Weather", "22 daily", "dailyWeather", "LOW"],
        ],
        [24, 30, 80, 28]
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 3: DATABASE STRUCTURE VISUAL MAP
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("3", "Database Structure & Entity Relationships")

    pdf.body_text(
        "All tables use UUID primary keys (gen_random_uuid). The restaurants table is the central entity - "
        "every data table references it via restaurantId. Data is organized by domain: labor (from 7shifts), "
        "sales (7shifts + Xenial), quality (Qualtrics + Google), operations (HME + Weather), "
        "and platform (auth, config, gamification)."
    )

    pdf.sub_title("Entity Relationship Diagram")

    y_start = pdf.get_y() + 2

    # Background
    pdf.set_fill_color(250, 250, 255)
    pdf.rect(10, y_start, 190, 155, 'F')
    pdf.set_draw_color(*C_BORDER)
    pdf.rect(10, y_start, 190, 155, 'D')

    # ── CENTRAL: restaurants ──
    rx, ry = 72, y_start + 4
    pdf.set_fill_color(*C_ENT_CORE)
    pdf.set_draw_color(30, 80, 180)
    pdf.set_line_width(0.6)
    pdf.rect(rx, ry, 56, 22, 'DF')
    pdf.set_font("Helvetica", "B", 9)
    pdf.set_text_color(*C_WHITE)
    pdf.set_xy(rx, ry + 2)
    pdf.cell(56, 5, "restaurants", align="C")
    pdf.set_font("Courier", "", 6)
    pdf.set_xy(rx + 2, ry + 8)
    pdf.cell(52, 3.5, "id (PK), name, timezone", align="C")
    pdf.set_xy(rx + 2, ry + 12)
    pdf.cell(52, 3.5, "unitNumber, laborTarget", align="C")
    pdf.set_xy(rx + 2, ry + 16)
    pdf.cell(52, 3.5, "lat/lng, openDate, isActive", align="C")
    pdf.set_line_width(0.2)

    # ── Helper to draw entity boxes ──
    def entity_box(x, y, w, title, fields, color):
        pdf.set_fill_color(*color)
        pdf.set_draw_color(max(0, color[0]-50), max(0, color[1]-50), max(0, color[2]-50))
        h = 8 + len(fields) * 3.5
        pdf.rect(x, y, w, h, 'DF')
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(*C_WHITE)
        pdf.set_xy(x, y + 1)
        pdf.cell(w, 4, title, align="C")
        pdf.set_font("Courier", "", 5.5)
        for i, f in enumerate(fields):
            pdf.set_xy(x + 1.5, y + 6 + i * 3.5)
            pdf.cell(w - 3, 3, f)
        return x + w/2, y + h  # return bottom center for arrows

    # ── LEFT COLUMN: Labor/Sales domain (7shifts) ──
    lx = 13

    # dailySales
    bx1, by1 = entity_box(lx, y_start + 32, 42, "dailySales", [
        "restaurantId (FK)", "salesDate, totalSales",
        "vsProjected, laborPercent", "locationCode"
    ], C_ENT_LABOR)

    # dailyLabor
    bx2, by2 = entity_box(lx, y_start + 60, 42, "dailyLabor", [
        "restaurantId (FK)", "date, laborPercent",
        "projected/actualLaborCost"
    ], C_ENT_LABOR)

    # hourlySales
    bx3, by3 = entity_box(lx, y_start + 84, 42, "hourlySales", [
        "restaurantId (FK)", "salesDate, hour (0-23)",
        "actual/projected/pastSales", "labor (legacy)"
    ], C_ENT_LABOR)

    # hourlyLabor
    bx4, by4 = entity_box(lx, y_start + 110, 42, "hourlyLabor", [
        "restaurantId (FK)", "date, hour (0-23)",
        "projected/actualLabor", "positionBreakdown {JSON}"
    ], C_ENT_LABOR)

    # ── CENTER-LEFT: Employees + Crew ──
    cx = 60

    # employees
    bx5, by5 = entity_box(cx, y_start + 32, 44, "employees", [
        "sevenShiftsUserId (UK)", "firstName, lastName",
        "hireDate, position, type", "locationId, restaurantId (FK)"
    ], C_ENT_LABOR)

    # hourlyCrew
    bx6, by6 = entity_box(cx, y_start + 60, 44, "hourlyCrew", [
        "restaurantId (FK)", "date, hour",
        "crewCount, avgTenureMonths", "experienceScore (0-100)",
        "tenureMix {JSON}", "crewMembers [{JSON}]"
    ], C_ENT_LABOR)

    # ── CENTER-RIGHT: POS + Mapping ──
    mx = 109

    # posOrders
    bx7, by7 = entity_box(mx, y_start + 32, 44, "posOrders", [
        "xenialOrderId (UK)", "storeNumber",
        "orderTotal, businessDate", "orderClosedAt, orderSource"
    ], C_ENT_POS)

    # locationMapping
    bx8, by8 = entity_box(mx, y_start + 60, 44, "locationMapping", [
        "xenialStoreNumber (UK)", "restaurantId (FK)",
        "sevenShiftsLocationId"
    ], C_ENT_POS)

    # ── RIGHT COLUMN: Quality + Enrichment ──
    qx = 153

    # osatData
    bx9, by9 = entity_box(qx, y_start + 32, 44, "osatData", [
        "restaurantId (FK)", "date, hour (0-23)",
        "totalResponses", "fiveStarCount, osatPercent"
    ], C_ENT_QUALITY)

    # dailyOsat
    bx10, by10 = entity_box(qx, y_start + 60, 44, "dailyOsat", [
        "restaurantId (FK)", "date",
        "totalResponses, osatPercent"
    ], C_ENT_QUALITY)

    # osatCategoryIssues
    bx11, by11 = entity_box(qx, y_start + 84, 44, "osatCategoryIssues", [
        "restaurantId (FK)", "date, hour",
        "orderAccuracy (1-5)", "foodQuality, speedOfService",
        "cleanliness, value, ..."
    ], C_ENT_QUALITY)

    # hmeTimerData
    bx12, by12 = entity_box(mx, y_start + 84, 44, "hmeTimerData", [
        "restaurantId (FK)", "date, hour",
        "carCount, avgTotalTime", "avgServiceTime, avgQueueTime"
    ], C_ENT_ENRICH)

    # dailyGoogleReviews
    bx13, by13 = entity_box(mx, y_start + 112, 44, "dailyGoogleReviews", [
        "restaurantId (FK)", "date",
        "rating (1.0-5.0)", "reviewCount, isFinalSnapshot"
    ], C_ENT_ENRICH)

    # dailyWeather
    bx14, by14 = entity_box(qx, y_start + 112, 44, "dailyWeather", [
        "restaurantId (FK)", "date",
        "high/low/avgTemp", "condition, humidity, wind"
    ], C_ENT_ENRICH)

    # ── BOTTOM: markets ──
    bx15, by15 = entity_box(lx, y_start + 137, 30, "markets", [
        "id (PK), name", "color (hex)"
    ], C_ENT_AUTH)

    bx16, by16 = entity_box(lx + 33, y_start + 137, 36, "restaurantMarkets", [
        "restaurantId (FK)", "marketId (FK)"
    ], C_ENT_AUTH)

    # ── Draw relationship arrows from restaurants to children ──
    rest_bottom = ry + 22
    rest_cx = rx + 28
    rest_left = rx
    rest_right = rx + 56

    # Arrows to left column
    pdf.draw_arrow(rest_left, rest_bottom, lx + 21, y_start + 32, C_ENT_LABOR)
    # Arrows to center-left
    pdf.draw_arrow(rest_cx, rest_bottom, cx + 22, y_start + 32, C_ENT_LABOR)
    # Arrows to center-right
    pdf.draw_arrow(rest_right, rest_bottom, mx + 22, y_start + 32, C_ENT_POS)
    # Arrows to right column
    pdf.draw_arrow(rest_right + 5, ry + 15, qx + 22, y_start + 32, C_ENT_QUALITY)

    # ── Legend ──
    ly = y_start + 155 + 4
    pdf.set_y(ly)
    pdf.set_font("Helvetica", "B", 8)
    pdf.set_text_color(*C_BLACK)
    pdf.cell(0, 5, "Legend:", ln=True)
    ly = pdf.get_y() + 1
    pdf.draw_legend_item(14, ly, C_ENT_CORE, "Core")
    pdf.draw_legend_item(48, ly, C_ENT_LABOR, "Labor / 7shifts")
    pdf.draw_legend_item(95, ly, C_ENT_POS, "POS / Xenial")
    pdf.draw_legend_item(135, ly, C_ENT_QUALITY, "Quality / OSAT")
    ly += 6
    pdf.draw_legend_item(14, ly, C_ENT_ENRICH, "Enrichment")
    pdf.draw_legend_item(48, ly, C_ENT_ARENA, "Arena / Gamification")
    pdf.draw_legend_item(95, ly, C_ENT_HIRING, "Hiring / Workstream")
    pdf.draw_legend_item(135, ly, C_ENT_AUTH, "Auth / Config")

    pdf.set_y(ly + 8)

    # ═══════════════════════════════════════════════════════════
    # Additional tables page
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.sub_title("Arena (Gamification) & Platform Tables")

    y_start = pdf.get_y() + 2
    pdf.set_fill_color(255, 250, 252)
    pdf.rect(10, y_start, 190, 70, 'F')
    pdf.set_draw_color(*C_BORDER)
    pdf.rect(10, y_start, 190, 70, 'D')

    # Arena tables
    entity_box(14, y_start + 5, 42, "arenaBadgesEarned", [
        "badgeId, entityId", "entityType (leader/unit)",
        "earnedAt, metricValue", "shiftTeamMembers [{JSON}]"
    ], C_ENT_ARENA)

    entity_box(60, y_start + 5, 38, "arenaStreaks", [
        "entityId, entityType", "streakStart, streakCount",
        "streakActive, endedAt"
    ], C_ENT_ARENA)

    entity_box(102, y_start + 5, 38, "arenaRecords", [
        "recordType, holderId", "holderType, value",
        "evalDate, teamMembers"
    ], C_ENT_ARENA)

    entity_box(144, y_start + 5, 50, "arenaMessages", [
        "recipientEmail, messageType", "subject, message",
        "auto (bool), team (bool)"
    ], C_ENT_ARENA)

    # Platform tables
    entity_box(14, y_start + 40, 35, "users", [
        "username (UK), password", "email, role, displayName"
    ], C_ENT_AUTH)

    entity_box(53, y_start + 40, 38, "magicLinkTokens", [
        "email, tokenHash", "expiresAt, consumedAt"
    ], C_ENT_AUTH)

    entity_box(95, y_start + 40, 40, "emailSubscribers", [
        "email (UK), name", "reportTime, reportTypes[]"
    ], C_ENT_AUTH)

    entity_box(139, y_start + 40, 38, "applicants", [
        "digestKey (UK)", "restaurantId (FK)",
        "positionTitle, status", "appliedAt, hiredAt"
    ], C_ENT_HIRING)

    pdf.set_y(y_start + 78)
    pdf.ln(2)

    pdf.sub_title("Complete Table Reference")
    pdf.draw_table(
        ["Table", "Source System", "Grain", "Key Columns"],
        [
            ["restaurants", "7shifts (sync)", "1 row/location", "id, name, timezone, unitNumber, laborTarget"],
            ["dailySales", "7shifts + Xenial", "1 row/day/restaurant", "restaurantId, salesDate, totalSales, vsProjected"],
            ["dailyLabor", "7shifts", "1 row/day/restaurant", "restaurantId, date, laborPercent, actual/projectedCost"],
            ["hourlySales", "7shifts + Xenial", "1 row/hour/restaurant", "restaurantId, salesDate, hour, actual/projected"],
            ["hourlyLabor", "7shifts punches", "1 row/hour/restaurant", "restaurantId, date, hour, positionBreakdown"],
            ["hourlyCrew", "7shifts derived", "1 row/hour/restaurant", "restaurantId, date, hour, tenureMix, crewMembers"],
            ["employees", "7shifts", "1 row/employee", "sevenShiftsUserId, name, hireDate, position"],
            ["posOrders", "Xenial webhook", "1 row/transaction", "xenialOrderId, storeNumber, orderTotal"],
            ["locationMapping", "Hardcoded", "1 row/store", "xenialStoreNumber, restaurantId, sevenShiftsLocationId"],
            ["hmeTimerData", "HME Cloud", "1 row/hour/restaurant", "restaurantId, date, hour, carCount, avgServiceTime"],
            ["osatData", "Qualtrics", "1 row/hour/restaurant", "restaurantId, date, hour, osatPercent"],
            ["dailyOsat", "Qualtrics", "1 row/day/restaurant", "restaurantId, date, osatPercent"],
            ["osatCategoryIssues", "Qualtrics", "1 row/response", "restaurantId, date, hour, category ratings 1-5"],
            ["dailyGoogleReviews", "Google Places", "1 row/day/restaurant", "restaurantId, date, rating, reviewCount"],
            ["dailyWeather", "Open-Meteo", "1 row/day/restaurant", "restaurantId, date, temp, condition"],
            ["applicants", "Workstream", "1 row/applicant", "digestKey, restaurantId, positionTitle, status"],
        ],
        [28, 26, 34, 80]
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 4: CROSS-SYSTEM IDENTITY
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("4", "Cross-System Identity Linking")

    pdf.body_text(
        "Every external system has its own location identifier. These are currently linked through "
        "name-matching patterns and a hardcoded mapping table. This is the most critical architecture "
        "concern for adding or replacing integrations."
    )

    pdf.sub_title("Location Identity Map")

    y_start = pdf.get_y() + 2
    pdf.set_fill_color(*C_LIGHT_BG)
    pdf.rect(10, y_start, 190, 68, 'F')
    pdf.set_draw_color(*C_BORDER)
    pdf.rect(10, y_start, 190, 68, 'D')

    # External system boxes at top
    systems = [
        ("7shifts", "location.id\n(e.g., 298133)", C_ENT_LABOR),
        ("Xenial POS", "store_number\n(e.g., \"1237\")", C_ENT_POS),
        ("Workstream", "digest_key\n(e.g., \"abc123\")", C_ENT_HIRING),
        ("Google", "place_id\n(e.g., \"ChIJ...\")", C_ENT_QUALITY),
        ("HME", "device mapping\n(by name match)", C_ENT_ENRICH),
    ]

    x = 14
    for name, sub_text, color in systems:
        pdf.draw_box(x, y_start + 4, 34, 14, name, color, sub_text.split('\n')[0], font_size=7)
        pdf.set_font("Courier", "", 5)
        pdf.set_text_color(*C_WHITE)
        pdf.set_xy(x, y_start + 14)
        pdf.cell(34, 3, sub_text.split('\n')[1] if '\n' in sub_text else '', align="C")
        x += 37

    # Central restaurants box
    cy = y_start + 38
    pdf.set_fill_color(*C_ENT_CORE)
    pdf.set_draw_color(30, 80, 180)
    pdf.set_line_width(0.8)
    pdf.rect(40, cy, 120, 18, 'DF')
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(*C_WHITE)
    pdf.set_xy(40, cy + 2)
    pdf.cell(120, 6, "restaurants.id  (Internal UUID)", align="C")
    pdf.set_font("Courier", "", 7)
    pdf.set_xy(40, cy + 9)
    pdf.cell(120, 5, 'name = "1237 - Athens"  |  unitNumber = "1237"', align="C")
    pdf.set_line_width(0.2)

    # Matching method labels
    methods = [
        (31, "Exact name match", "(FRAGILE)"),
        (68, "Regex prefix", "(MEDIUM)"),
        (105, "Fuzzy name", "(FRAGILE)"),
        (142, "Explicit ID", "(SAFE)"),
        (179, "Name pattern", "(FRAGILE)"),
    ]

    for mx_pos, method, risk in methods:
        # Arrow from system down to restaurants
        pdf.draw_arrow(mx_pos, y_start + 18, mx_pos, cy, C_GRAY, dashed=True)
        pdf.set_font("Helvetica", "", 5)
        pdf.set_text_color(*C_ACCENT)
        pdf.set_xy(mx_pos - 14, y_start + 24)
        pdf.cell(28, 3, method, align="C")
        pdf.set_xy(mx_pos - 14, y_start + 27)
        pdf.cell(28, 3, risk, align="C")

    pdf.set_y(y_start + 72)

    pdf.bold_text("Current Matching Strategies & Risk Assessment:")
    pdf.draw_table(
        ["From System", "To System", "Method", "Risk Level", "Failure Mode"],
        [
            ["7shifts", "restaurants", "Exact name match via location.name", "HIGH", "Renaming location breaks sync"],
            ["Xenial POS", "restaurants", "Regex: name.match(/^(\\d{4})\\s*-/)", "MEDIUM", "Non-standard name format breaks"],
            ["Xenial", "7shifts", "Hardcoded array (xenial-webhook.ts:340)", "VERY HIGH", "New locations need code deploy"],
            ["Workstream", "restaurants", "Fuzzy name match during sync", "HIGH", "Name differences cause orphans"],
            ["Google Places", "restaurants", "googlePlaceId column on restaurants", "LOW", "Explicit ID - safe"],
            ["HME", "restaurants", "Name pattern matching", "HIGH", "Name inconsistency causes gaps"],
        ],
        [26, 22, 56, 22, 48]
    )

    pdf.bold_text("Recommended Future State:")
    pdf.body_text(
        "Move all external IDs to explicit columns on the restaurants table. This eliminates name-matching "
        "fragility and makes adding new integrations straightforward. The restaurants table should become a "
        "canonical location registry with one column per external system ID."
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 5: 7SHIFTS DEEP DIVE
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("5", "7shifts API Deep Dive")

    pdf.body_text(
        "7shifts is the PRIMARY data backbone of the system. It provides location data, sales forecasts, "
        "labor cost/hours, employee records, time punches, role definitions, and scheduled shifts. The API "
        "client is in server/scraper/7shifts-api.ts (~1,960 lines)."
    )

    pdf.sub_title("API Endpoints Used")
    pdf.draw_table(
        ["Endpoint", "Data Returned", "Stored In", "Frequency"],
        [
            ["GET /v2/whoami", "Company ID, auth validation", "In-memory", "On startup"],
            ["GET /v2/company/{id}/locations", "All locations: name, tz, lat/lng", "restaurants", "On startup"],
            ["GET /v2/reports/daily_sales_and_labor", "Daily: actual/projected sales, labor %", "dailySales, dailyLabor", "Every 5 min"],
            ["GET /v2/.../daily_stats", "Hourly: sales intervals, labor", "hourlySales, hourlyLabor", "Every 5 min"],
            ["GET /v2/company/{id}/time_punches", "Clock in/out, role_id, breaks", "Derived -> hourlyLabor", "Every 5 min"],
            ["GET /v2/company/{id}/roles", "role_id -> position name mapping", "In-memory (runtime)", "Per sync"],
            ["GET /v2/company/{id}/shifts", "Scheduled shifts with roles", "Operator detection", "Per sync"],
            ["GET /v2/company/{id}/users", "Employee name, hire_date, type", "employees", "Daily"],
        ],
        [48, 52, 44, 24]
    )

    pdf.sub_title("7shifts-Specific Concepts Embedded in the System")

    pdf.bold_text("Employee Tenure Categories (hardcoded thresholds):")
    pdf.draw_table(
        ["Category", "Tenure Threshold", "Experience Score Weight", "Used In"],
        [
            ["Trainee", "< 3 months", "25 points", "hourlyCrew.tenureMix, experience score"],
            ["Developing", "3-6 months", "50 points", "hourlyCrew.tenureMix, experience score"],
            ["Experienced", "6-12 months", "75 points", "hourlyCrew.tenureMix, experience score"],
            ["Veteran", "12+ months", "100 points", "hourlyCrew.tenureMix, experience score"],
        ],
        [30, 32, 40, 70]
    )

    pdf.bold_text("Data Format Conventions:")
    pdf.body_text(
        "- Sales values from 7shifts are in INTEGER CENTS (divided by 100 before storage)\n"
        "- labor_percent is returned as decimal 0-1 (multiplied by 100 before storage)\n"
        "- projected_labor_cost is in cents (divided by 100)\n"
        "- Time punches use ISO timestamps with timezone offsets\n"
        "- Fractional labor hours: a punch 10:30-11:30 = 0.5 hrs in hour 10 + 0.5 hrs in hour 11\n"
        "- Operator detection: checks if scheduled shift role name includes 'Operator'\n"
        "- Overnight handling: 4-hour padding before/after business day for spanning shifts"
    )

    pdf.sub_title("Files with Direct 7shifts Coupling")
    pdf.draw_table(
        ["File", "~Lines", "Coupling Type"],
        [
            ["server/scraper/7shifts-api.ts", "1,960", "Core API client - all sync functions"],
            ["server/scraper/7shifts-scraper.ts", "391", "Browser scraper fallback (Playwright)"],
            ["server/scheduler.ts", "546", "Orchestrates all 7shifts sync calls"],
            ["server/xenial-webhook.ts", "407", "Hardcoded 7shifts location ID mappings"],
            ["shared/schema.ts", "710", "sevenShiftsUserId, sevenShiftsLocationId columns"],
            ["server/storage.ts", "450+", "Labor data lookups keyed by 7shifts-populated data"],
        ],
        [60, 20, 90]
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 6: SYNC PIPELINE VISUAL
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("6", "Sync Pipeline & Data Flow")

    pdf.body_text(
        "The scheduler runs every 5 minutes, executing sync tasks in a specific order. "
        "Each task is independent but executed sequentially to avoid overwhelming external APIs."
    )

    pdf.sub_title("Scheduler Execution Flow (every 5 minutes)")

    y_start = pdf.get_y() + 2
    steps = [
        ("1", "fetchSalesFromAPI()", "7shifts daily sales + labor %", C_ENT_LABOR),
        ("2", "fetchHourlySalesFromAPI()", "7shifts hourly intervals + time punches", C_ENT_LABOR),
        ("3", "syncSalesWithXenialPOS()", "Overlay Xenial POS real-time sales", C_ENT_POS),
        ("4", "syncHMETimerData()", "HME drive-thru car counts + times", C_ENT_ENRICH),
        ("5", "syncCrewExperience...()", "Hourly crew (top of hour only)", C_ENT_LABOR),
        ("6", "syncGoogleReviews...()", "Google review ratings (hourly)", C_ENT_QUALITY),
        ("7", "syncOsatIfNeeded()", "Qualtrics OSAT surveys", C_ENT_QUALITY),
        ("8", "saveEndOfDayWeather...()", "Weather snapshot (11 PM CT only)", C_ENT_ENRICH),
        ("9", "syncYesterday...()", "Re-sync yesterday (midnight-6AM CT)", C_ENT_LABOR),
        ("10", "sendDailyReports...()", "Email reports at configured time", C_ENT_AUTH),
    ]

    for i, (num, func, desc, color) in enumerate(steps):
        y = y_start + i * 9
        # Step number circle
        pdf.set_fill_color(*color)
        pdf.ellipse(14, y + 1, 7, 7, 'F')
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(*C_WHITE)
        pdf.set_xy(14, y + 2.5)
        pdf.cell(7, 3, num, align="C")

        # Function name
        pdf.set_font("Courier", "B", 8)
        pdf.set_text_color(*C_BLACK)
        pdf.set_xy(24, y + 1)
        pdf.cell(60, 5, func)

        # Description
        pdf.set_font("Helvetica", "", 8)
        pdf.set_text_color(*C_GRAY)
        pdf.set_xy(90, y + 1)
        pdf.cell(100, 5, desc)

        # Connector line
        if i < len(steps) - 1:
            pdf.set_draw_color(*C_BORDER)
            pdf.line(17.5, y + 8, 17.5, y + 10)

    pdf.set_y(y_start + len(steps) * 9 + 4)

    pdf.sub_title("Data Layering Strategy")
    pdf.body_text(
        "The system uses a layered approach where 7shifts provides the baseline and other "
        "sources overlay or enrich the same time slots:"
    )

    layers = [
        ("Layer 1", "7shifts baseline", "Sales forecasts, projected labor, hourly intervals", C_ENT_LABOR),
        ("Layer 2", "Xenial POS overlay", "Replaces 7shifts sales with real-time POS totals", C_ENT_POS),
        ("Layer 3", "7shifts time punches", "Actual labor hours by position (separate table)", C_ENT_LABOR),
        ("Layer 4", "HME enrichment", "Drive-thru metrics attached to same hourly slots", C_ENT_ENRICH),
        ("Layer 5", "Qualtrics enrichment", "OSAT scores attached to same hourly slots", C_ENT_QUALITY),
        ("Layer 6", "Google Places", "Daily review rating snapshots", C_ENT_QUALITY),
        ("Layer 7", "Weather", "Daily weather context per location", C_ENT_ENRICH),
    ]

    y_start = pdf.get_y() + 2
    for i, (layer, source, desc, color) in enumerate(layers):
        y = y_start + i * 8.5
        pdf.set_fill_color(*color)
        alpha = 1.0 - i * 0.07
        pdf.rect(14, y, 182, 7.5, 'F')
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_text_color(*C_WHITE)
        pdf.set_xy(16, y + 1)
        pdf.cell(20, 5, layer)
        pdf.set_font("Helvetica", "B", 7)
        pdf.set_xy(38, y + 1)
        pdf.cell(36, 5, source)
        pdf.set_font("Helvetica", "", 7)
        pdf.set_xy(78, y + 1)
        pdf.cell(120, 5, desc)

    pdf.set_y(y_start + len(layers) * 8.5 + 5)

    pdf.sub_title("Startup Sequence")
    pdf.body_text(
        "1. Check if 7-day historical data exists (needed for week-over-week comparisons)\n"
        "2. If missing: PAUSE scheduler -> backfill 9 days of daily + hourly data -> RESUME\n"
        "3. Start scheduler timer (aligned to 5-min intervals)\n"
        "4. Run initial sync immediately (ensures data on fresh deploy)\n"
        "5. Force crew sync for today + yesterday\n"
        "6. Schedule daily data cleanup (midnight, 730-day retention)"
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 7: MIGRATION PLAYBOOK
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("7", "Replacing 7shifts - Migration Playbook")

    pdf.body_text(
        "If 7shifts is replaced with another labor management system, the migration touches "
        "6+ files and requires careful handling of identity, data formats, and historical continuity."
    )

    pdf.sub_title("What a Replacement System Must Provide")
    pdf.draw_table(
        ["Capability", "7shifts Source", "Required From Replacement", "Critical?"],
        [
            ["Location list", "/v2/.../locations", "All locations with name, tz, lat/lng", "YES"],
            ["Daily sales summary", "/v2/reports/daily_sales_and_labor", "Actual/projected sales, labor %, cost", "YES"],
            ["Hourly intervals", "/v2/.../daily_stats", "Per-hour actual/projected/past sales + labor", "YES"],
            ["Time punches", "/v2/.../time_punches", "Per-employee clock in/out with role + location", "YES"],
            ["Role/position map", "/v2/.../roles", "role_id -> human-readable position name", "YES"],
            ["Employee directory", "/v2/.../users", "Name, hire_date, active status, type, location", "YES"],
            ["Scheduled shifts", "/v2/.../shifts", "Start/end with role (for Operator detection)", "MEDIUM"],
            ["Sales forecasting", "Embedded in daily_stats", "Projected sales by hour and day", "MEDIUM"],
        ],
        [30, 44, 64, 20]
    )

    pdf.sub_title("4-Phase Migration Plan")

    phases = [
        ("Phase 1: Create Provider Abstraction",
         "Create server/providers/labor-provider.ts with a common interface (getLocations, getDailySummary, "
         "getHourlyIntervals, getTimePunches, getRoles, getEmployees, getScheduledShifts). "
         "Refactor current 7shifts code to implement this interface."),
        ("Phase 2: Normalize Identity",
         "Replace name-based matching with explicit ID columns on the restaurants table. "
         "Add laborPlatformLocationId column. Populate from current 7shifts data. "
         "Update sync functions to use explicit ID matching."),
        ("Phase 3: Decouple Schema",
         "Rename 7shifts-specific columns: employees.sevenShiftsUserId -> externalUserId (+ externalSource field), "
         "locationMapping.sevenShiftsLocationId -> laborPlatformLocationId. "
         "Add migration scripts for column renames."),
        ("Phase 4: Swap API Client",
         "Implement new provider (e.g., HotSchedules, R365, etc.). Update scheduler.ts imports. "
         "Map new data formats to normalized structures. Run parallel (old + new) before cutover."),
    ]

    for title, desc in phases:
        pdf.bold_text(title)
        pdf.body_text(desc)

    pdf.sub_title("Hardcoded Values Requiring Update")
    pdf.draw_table(
        ["Value", "Location", "Action Required"],
        [
            ["https://api.7shifts.com", "7shifts-api.ts:139", "Replace with new provider base URL"],
            ["SEVENSHIFTS_API_TOKEN env var", "Multiple files", "Replace with new provider auth"],
            ["Store <-> 7shifts ID array", "xenial-webhook.ts:340-362", "Update with new labor system IDs"],
            ["Employee type values", "7shifts-api.ts (employee, manager...)", "Map new provider's role types"],
            ["/v2/ endpoint paths", "Throughout 7shifts-api.ts", "Replace with new API paths"],
            ["Cents-to-dollars conversion", "7shifts-api.ts (÷ 100)", "Verify new provider's units"],
        ],
        [50, 56, 68]
    )

    pdf.bold_text("Data Continuity Notes:")
    pdf.body_text(
        "- Historical data is safe: hourly/daily data tables have no 7shifts-specific format\n"
        "- Employee records need mapping: sevenShiftsUserId is the unique key; new provider has different IDs\n"
        "- Tenure calculations continue if new system provides hire_date\n"
        "- Position names may differ: '7shifts Grill' vs new system's equivalent. Update position logic.\n"
        "- The frontend is already decoupled: it consumes normalized TypeScript interfaces, NOT provider data"
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 8: MODULE ROADMAP
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("8", "Module Roadmap & Future Integrations")

    pdf.body_text(
        "The following modules are planned to extend the operational back-office platform. "
        "Each module builds on existing data and the restaurants/employees entity graph."
    )

    # Module roadmap visual
    pdf.sub_title("Integration Dependency Map")

    y_start = pdf.get_y() + 2
    pdf.set_fill_color(248, 250, 255)
    pdf.rect(10, y_start, 190, 75, 'F')
    pdf.set_draw_color(*C_BORDER)
    pdf.rect(10, y_start, 190, 75, 'D')

    # Core data layer
    pdf.set_font("Helvetica", "B", 7)
    pdf.set_text_color(*C_GRAY)
    pdf.set_xy(14, y_start + 2)
    pdf.cell(40, 4, "CORE DATA (existing)")

    core_boxes = [
        ("Employees", C_ENT_LABOR),
        ("Sales/Labor", C_ENT_LABOR),
        ("OSAT", C_ENT_QUALITY),
        ("POS Orders", C_ENT_POS),
        ("Reviews", C_ENT_QUALITY),
        ("Locations", C_ENT_CORE),
    ]
    x = 14
    for name, color in core_boxes:
        pdf.draw_box(x, y_start + 7, 28, 10, name, color, font_size=7)
        x += 30

    # Future modules row
    pdf.set_font("Helvetica", "B", 7)
    pdf.set_text_color(*C_GRAY)
    pdf.set_xy(14, y_start + 24)
    pdf.cell(40, 4, "PLANNED MODULES")

    modules = [
        ("Training", (168, 85, 247), "Employees\nLocations"),
        ("Inventory", (234, 88, 12), "POS Orders\nSales"),
        ("Provisioning", (22, 163, 74), "Employees\nLocations"),
        ("CRM", (236, 72, 153), "OSAT, Reviews\nPOS, Employees"),
        ("Payroll", (6, 182, 212), "Labor Hours\nEmployees"),
        ("Analytics", (107, 114, 128), "All Data\nSources"),
    ]

    x = 14
    for name, color, deps in modules:
        pdf.draw_box(x, y_start + 30, 28, 12, name, color, font_size=7)
        # Draw dependency text
        pdf.set_font("Helvetica", "", 5)
        pdf.set_text_color(*C_GRAY)
        for j, line in enumerate(deps.split('\n')):
            pdf.set_xy(x, y_start + 44 + j * 3)
            pdf.cell(28, 3, line, align="C")
        x += 30

    # Dependency arrows
    pdf.set_font("Helvetica", "B", 7)
    pdf.set_text_color(*C_GRAY)
    pdf.set_xy(14, y_start + 54)
    pdf.cell(40, 4, "EXTERNAL CONNECTIONS")

    ext_future = [
        ("LMS Platform", (168, 85, 247), "e.g., Wisetail"),
        ("Inventory Mgmt", (234, 88, 12), "e.g., R365"),
        ("Identity Provider", (22, 163, 74), "e.g., Okta/Azure"),
        ("Helpdesk/CRM", (236, 72, 153), "e.g., Zendesk"),
        ("Payroll System", (6, 182, 212), "e.g., ADP/Gusto"),
        ("Data Warehouse", (107, 114, 128), "e.g., BigQuery"),
    ]

    x = 14
    for name, color, sub in ext_future:
        pdf.draw_box(x, y_start + 59, 28, 11, name, color, sub, font_size=6)
        x += 30

    pdf.set_y(y_start + 80)

    # ── Module Details ──
    pdf.sub_title("8.1 Training System")
    pdf.body_text(
        "Purpose: Training tracking, certification management, onboarding workflows.\n\n"
        "Data Dependencies:\n"
        "  - employees table (name, position, hireDate, restaurantId) for enrollment triggers\n"
        "  - Tenure categories (Trainee < 3mo) as auto-enrollment triggers\n"
        "  - hourlyCrew.crewMembers for on-shift training status\n\n"
        "New Tables: trainingCourses, trainingEnrollments, trainingCertifications\n"
        "Trigger: syncEmployees() creates new employee -> auto-enroll in position-appropriate courses"
    )

    pdf.sub_title("8.2 Inventory & Ordering")
    pdf.body_text(
        "Purpose: Track inventory levels, COGS, waste, and product-level sales mix.\n\n"
        "Data Dependencies:\n"
        "  - posOrders (Xenial webhook) for revenue data. NOTE: product-level line items are NOT currently parsed\n"
        "  - posOrders.rawJson MAY contain line-item data that can be parsed\n"
        "  - hourlySales for revenue context\n\n"
        "New Tables: products, inventoryLevels, orderItems, purchaseOrders\n"
        "Action: Parse line items from existing rawJson OR add Xenial webhook entity type"
    )

    pdf.sub_title("8.3 User Provisioning & Lifecycle")
    pdf.body_text(
        "Purpose: Auto-provision/deprovision accounts across systems on hire/transfer/termination.\n\n"
        "Data Dependencies:\n"
        "  - Employee sync detects new hires (inserts) and status changes (active flag)\n"
        "  - applicants table tracks 'hired' status from Workstream\n"
        "  - employees.locationId changes indicate transfers\n\n"
        "New Tables: provisioningEvents, provisioningRules\n"
        "Events: employee.created -> invite to POS + training + comms\n"
        "         employee.locationChanged -> update access across systems\n"
        "         employee.deactivated -> revoke all system access"
    )

    pdf.add_page()
    pdf.sub_title("8.4 CRM (Customer Relationship Management)")
    pdf.body_text(
        "Purpose: Support case management, customer interaction tracking, marketing campaigns.\n\n"
        "Data Dependencies:\n"
        "  - osatData / osatCategoryIssues: low scores auto-create support cases\n"
        "  - dailyGoogleReviews: rating drops trigger review alerts\n"
        "  - posOrders: link to customer purchase history\n"
        "  - restaurants: geographic context for regional marketing\n\n"
        "New Tables: customers, customerInteractions, supportCases, marketingCampaigns\n"
        "Auto-triggers:\n"
        "  - OSAT < 60% -> create 'OSAT Alert' case\n"
        "  - Google rating drop > 0.2 in a day -> create 'Review Alert' case\n"
        "  - New 1-star survey -> create individual follow-up case"
    )

    pdf.sub_title("8.5 Payroll Integration")
    pdf.body_text(
        "Purpose: Export labor hours, overtime, and position data to payroll processor.\n\n"
        "Data Dependencies:\n"
        "  - hourlyLabor: position breakdowns and hours per employee\n"
        "  - dailyLabor: daily totals and labor cost\n"
        "  - employees: names, positions, locations, hire dates\n\n"
        "New Tables: payrollExports, payrollLineItems\n"
        "Export: Aggregate hourlyLabor into weekly summaries per employee,\n"
        "        map positions to pay rates, export CSV/API to ADP, Gusto, Paychex, etc."
    )

    pdf.sub_title("8.6 Analytics & Financial Export")
    pdf.body_text(
        "Purpose: Export operational data to financial systems, BI tools, accounting platforms.\n\n"
        "Data Dependencies:\n"
        "  - ALL data tables are potential export sources\n"
        "  - dailySales + dailyLabor are primary financial metrics\n"
        "  - posOrders for transaction-level detail\n\n"
        "New Tables: exportConfigurations, exportRuns\n"
        "Destinations: QuickBooks, Xero, NetSuite, Looker, Tableau, BigQuery, Snowflake\n"
        "Formats: CSV (accounting), JSON API (push), SQL (replication), Webhook (event-driven)"
    )

    # ═══════════════════════════════════════════════════════════
    # SECTION 9: ENVIRONMENT VARIABLES
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.section_title("9", "Environment Variables Reference")

    pdf.sub_title("Required Variables")
    pdf.draw_table(
        ["Variable", "Used By", "Purpose"],
        [
            ["DATABASE_URL", "server/db.ts", "Primary PostgreSQL connection string"],
            ["SEVENSHIFTS_API_TOKEN", "server/scraper/7shifts-api.ts", "7shifts API bearer token"],
            ["HME_SERVICE_ACCOUNT", "server/scraper/hme-api.ts", "HME Cloud service account ID"],
            ["HME_AUTH_KEY", "server/scraper/hme-api.ts", "HME Cloud authentication key"],
            ["HME_ACCOUNT_EMAIL", "server/scraper/hme-api.ts", "HME Cloud account email"],
            ["QUALTRICS_API_TOKEN", "server/scraper/qualtrics-api.ts", "Qualtrics API authentication token"],
            ["QUALTRICS_IDP_SOURCE_ID", "server/scraper/qualtrics-api.ts", "Qualtrics imported data project ID"],
            ["GOOGLE_PLACES_API_KEY", "server/google-places.ts", "Google Places API key"],
            ["RESEND_API_KEY", "server/email.ts", "Resend email service API key"],
            ["ALLOWED_LOGIN_EMAILS", "server/routes/auth.ts", "Comma-separated email whitelist"],
            ["SESSION_SECRET", "server/index.ts", "Express session encryption key"],
        ],
        [50, 56, 68]
    )

    pdf.sub_title("Optional Variables")
    pdf.draw_table(
        ["Variable", "Used By", "Purpose"],
        [
            ["XPOSSHARED_DATABASE_URL", "server/db.ts", "Separate POS database (fallback: DATABASE_URL)"],
            ["SHARED_DATABASE_URL", "server/db.ts", "Fallback for both database URLs"],
            ["RESEND_FROM_EMAIL", "server/email.ts", "Custom from address for emails"],
            ["WORKSTREAM_API_TOKEN", "server/scraper/7shifts-scraper.ts", "Workstream hiring platform auth"],
            ["GOOGLE_PLACES_LOCATION_CACHE", "server/google-places.ts", "Cached place IDs (JSON)"],
            ["SEVENSHIFTS_EMAIL", "server/scraper/7shifts-scraper.ts", "Browser scraper login email"],
            ["SEVENSHIFTS_PASSWORD", "server/scraper/7shifts-scraper.ts", "Browser scraper login password"],
        ],
        [56, 56, 62]
    )

    # ═══════════════════════════════════════════════════════════
    # KEY TAKEAWAYS (final page)
    # ═══════════════════════════════════════════════════════════
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 20)
    pdf.set_text_color(*C_PRIMARY)
    pdf.cell(0, 12, "Key Takeaways", ln=True)
    pdf.set_draw_color(*C_ACCENT)
    pdf.set_line_width(0.6)
    y = pdf.get_y()
    pdf.line(10, y, 100, y)
    pdf.set_line_width(0.2)
    pdf.ln(6)

    takeaways = [
        ("Frontend is already decoupled",
         "The React frontend consumes normalized TypeScript interfaces (RestaurantSales, HourlySalesData, etc.). "
         "Any backend provider swap is invisible to the frontend. No frontend changes required."),

        ("Location identity is the biggest migration risk",
         "The current system relies on name matching ('1237 - Athens'). Move to explicit ID columns on the "
         "restaurants table before adding more integrations. This is the single highest-priority refactor."),

        ("Employee identity is tied to sevenShiftsUserId",
         "Any new labor platform introduces a new ID space. Plan for a mapping/merge strategy with a "
         "transitional externalUserId + externalSource column approach."),

        ("The scheduler is the integration orchestrator",
         "All new data sources should follow the same pattern: create a sync function, add it to the scheduler "
         "with appropriate frequency and deduplication guards (like the syncKey pattern)."),

        ("The data layering strategy works well",
         "7shifts provides baselines, Xenial POS overlays real-time sales, enrichment sources attach to the same "
         "hourly time slots. New modules should follow this pattern of additive layers."),

        ("Hardcoded mappings are tech debt priority #1",
         "The Xenial-to-7shifts mapping array in xenial-webhook.ts:340-362 and name-matching patterns "
         "throughout will not scale. Every new location currently requires a code deployment."),
    ]

    for i, (title, desc) in enumerate(takeaways):
        # Number badge
        pdf.set_fill_color(*C_PRIMARY)
        badge_y = pdf.get_y()
        pdf.ellipse(12, badge_y, 8, 8, 'F')
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(*C_WHITE)
        pdf.set_xy(12, badge_y + 1.5)
        pdf.cell(8, 5, str(i + 1), align="C")

        # Title + description
        pdf.set_xy(24, badge_y)
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(*C_PRIMARY)
        pdf.cell(0, 6, title, ln=True)
        pdf.set_x(24)
        pdf.set_font("Helvetica", "", 8.5)
        pdf.set_text_color(*C_BLACK)
        pdf.multi_cell(170, 4.5, desc)
        pdf.ln(3)

    # Footer note
    pdf.ln(8)
    pdf.set_draw_color(*C_BORDER)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(*C_GRAY)
    pdf.cell(0, 5, "This document should be updated as integrations are added, replaced, or modified.", align="C", ln=True)
    pdf.cell(0, 5, "Source: docs/architecture-reference.md  |  Generated: February 2026", align="C")

    # ── Save ──
    output_path = os.path.join(os.path.dirname(__file__), "WBRS-Architecture-Reference.pdf")
    pdf.output(output_path)
    print(f"PDF generated: {output_path}")
    return output_path


if __name__ == "__main__":
    build_pdf()
