# MWB Dashboard - Shift Grading System Guide

## Overview

The MWB Dashboard grades each hour of operation based on three performance components: **Sales**, **Speed of Service**, and **Staffing**. The system adapts gracefully when data is missing, only grading on the components that have valid data.

---

## The Three Grading Components

### 1. Sales Performance (vs. Last Week)

Compares current hour's sales to the same hour last week.

| Condition | Score | Description |
|-----------|-------|-------------|
| Sales within 5% of last week or higher | 100 | Meeting or exceeding expectations |
| Sales more than 5% below last week | 50 | Below expectations |

**When data is missing:**
- If no last-week data exists for comparison, this component is **skipped** (not counted)
- First-week restaurants get a neutral score of 100 (benefit of the doubt)

---

### 2. Speed of Service (Drive-Thru)

Measures average total time in the drive-thru lane.

| Time | Score | Color Code |
|------|-------|------------|
| Under 5 minutes | 100 | Green |
| 5-7 minutes | 70 | Yellow/Amber |
| Over 7 minutes | 40 | Red |

**When data is missing:**
- If no HME timer data exists (no cars processed, timer offline), this component is **skipped**
- A score of 0 seconds is treated as "no data" not "instant service"

---

### 3. Staffing Level

Compares actual employees on the clock to the recommended staffing level based on the labor model.

| Condition | Score | Description |
|-----------|-------|-------------|
| Within ±1 of target | 100 | Properly staffed |
| More than 1 over target | 60 | Overstaffed |
| More than 1 under target | 60 | Understaffed |

**Sales Surge Exception:**
- If sales are **20% or more above last week**, understaffing is NOT penalized
- This recognizes unexpected rushes that couldn't have been anticipated
- Overstaffing is always counted (controllable by management)

**When data is missing:**
- If employee count is 0 or unavailable (7shifts API gap), this component is **skipped**

---

## How the Final Grade is Calculated

1. **Collect available components** - Only components with valid data are included
2. **Calculate average score** - Equal weight for each available component
3. **Convert to letter grade** based on the average:

| Average Score | Grade | Color |
|---------------|-------|-------|
| 97-100 | A+ | Green |
| 93-96 | A | Green |
| 90-92 | A- | Green |
| 87-89 | B+ | Blue |
| 83-86 | B | Blue |
| 80-82 | B- | Blue |
| 77-79 | C+ | Yellow |
| 73-76 | C | Yellow |
| 70-72 | C- | Yellow |
| 67-69 | D+ | Orange |
| 63-66 | D | Orange |
| 60-62 | D- | Orange |
| Below 60 | F | Red |

---

## Examples

### Example 1: All Data Available

**Hour: 12 PM**
- Sales: $1,200 (up 8% vs last week) → Score: 100
- Speed: 4:30 average → Score: 100
- Staffing: 6 employees, target 6 → Score: 100

**Calculation:** (100 + 100 + 100) / 3 = 100 → **Grade: A+**

---

### Example 2: Missing Drive-Thru Data

**Hour: 12 PM**
- Sales: $1,200 (down 8% vs last week) → Score: 50
- Speed: No data (timer offline) → **Skipped**
- Staffing: 6 employees, target 6 → Score: 100

**Calculation:** (50 + 100) / 2 = 75 → **Grade: B**

Note: The grade is based only on the 2 available components.

---

### Example 3: Sales Surge Exception

**Hour: 12 PM**
- Sales: $1,500 (up 25% vs last week) → Score: 100
- Speed: 6:30 average → Score: 70
- Staffing: 4 employees, target 6 (2 under) → **Score: 100** (surge exception applies!)

**Calculation:** (100 + 70 + 100) / 3 = 90 → **Grade: A**

Without the surge exception, staffing would have been 60 and grade would be C.

---

### Example 4: First Week Restaurant

**Hour: 12 PM**
- Sales: No last week to compare (first week) → Score: 100 (neutral)
- Speed: 5:45 average → Score: 70
- Staffing: 5 employees, target 5 → Score: 100

**Calculation:** (100 + 70 + 100) / 3 = 90 → **Grade: A**

---

### Example 5: No Data Available

**Hour: 6 AM**
- Sales: $0 (store just opened, no last week data)
- Speed: No cars yet
- Staffing: No time punches recorded yet

**Result:** No components to grade → **Grade: -** (dash/no grade)

---

## Daily Summary View

The MWB Dashboard aggregates hourly grades to show:

- **Overall daily grade** - Average of all hourly grades
- **Understaffed hours** - Count of hours more than 1 under target (excluding surge hours)
- **Overstaffed hours** - Count of hours more than 1 over target
- **Slow speed hours** - Count of hours with drive-thru over 7 minutes
- **Sales outliers** - Hours 20%+ above or below last week

---

## Key Takeaways for Managers

1. **Missing data doesn't hurt you** - The system only grades on what it can measure
2. **Unexpected rushes are forgiven** - 20%+ sales surge protects against understaffing penalties
3. **Overstaffing is always flagged** - This is within management's control
4. **Speed matters** - Keep drive-thru under 5 minutes for best scores
5. **Consistency is key** - Matching or beating last week's sales earns full credit

---

## Troubleshooting

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| Grade shows "-" | No valid data for any component | Check if store is open, data syncing |
| Staffing always shows 0 | 7shifts not syncing | Contact support to verify time punch sync |
| No speed data | HME timer offline or no cars | Check timer connection |
| First week shows neutral | Expected behavior | Grade will be more accurate after first full week |

---

*Last Updated: February 2026*
