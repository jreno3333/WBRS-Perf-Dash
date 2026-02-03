# MWB Dashboard - People Tenure & Experience Guide

## Overview

The People Tenure system tracks employee experience levels across all restaurants, providing visibility into team composition and leadership performance. This helps identify staffing strengths, training needs, and recognize high-performing leaders.

---

## Tenure Categories

Employees are automatically categorized based on their time with the company (calculated from hire date in 7shifts):

| Category | Code | Time with Company | Score Value | Color |
|----------|------|-------------------|-------------|-------|
| **Training** | T | Less than 90 days | 25 | Red |
| **Developing** | D | 90 days to 6 months | 50 | Orange |
| **Experienced** | E | 6 months to 1 year | 75 | Green |
| **Veteran** | V | Over 1 year | 100 | Blue |

### Category Definitions

**Training (T) - Under 90 Days**
- Brand new team members still learning the basics
- May require more supervision and guidance
- Focus: Learning menu, procedures, and systems

**Developing (D) - 90 Days to 6 Months**
- Has completed initial training period
- Building speed and consistency
- Focus: Becoming proficient in assigned stations

**Experienced (E) - 6 Months to 1 Year**
- Solid performer who knows the operation well
- Can work independently and help train others
- Focus: Mastering multiple stations, cross-training

**Veteran (V) - Over 1 Year**
- Highly experienced team member
- Deep knowledge of all aspects of the operation
- Focus: Leadership, mentoring, setting the standard

---

## Experience Score Calculation

The Experience Score (0-100) measures the overall experience level of a crew working a specific hour.

### How It's Calculated

Each crew member contributes their tenure score to the hourly average:

```
Experience Score = (T × 25 + D × 50 + E × 75 + V × 100) / Total Crew
```

Where:
- T = Number of Training employees
- D = Number of Developing employees  
- E = Number of Experienced employees
- V = Number of Veteran employees

### Score Interpretation

| Score Range | Meaning | Color |
|-------------|---------|-------|
| 85-100 | Very experienced crew | Green |
| 70-84 | Solid experience mix | Yellow |
| 50-69 | Developing crew | Orange |
| Below 50 | Inexperienced crew | Red |

---

## Examples

### Example 1: Veteran-Heavy Crew
**Hour: 11 AM**
- 2 Veterans (V)
- 1 Experienced (E)
- 1 Developing (D)

**Score:** (0×25 + 1×50 + 1×75 + 2×100) / 4 = **81.25**

This crew has strong experience - great for a lunch rush.

---

### Example 2: Training-Heavy Crew
**Hour: 3 PM**
- 1 Veteran (V)
- 0 Experienced (E)
- 2 Developing (D)
- 3 Training (T)

**Score:** (3×25 + 2×50 + 0×75 + 1×100) / 6 = **45.8**

This crew needs more supervision - good for slower periods but risky for rushes.

---

### Example 3: Balanced Crew
**Hour: 6 PM**
- 1 Veteran (V)
- 2 Experienced (E)
- 2 Developing (D)
- 1 Training (T)

**Score:** (1×25 + 2×50 + 2×75 + 1×100) / 6 = **62.5**

A balanced crew mixing experience with development opportunities.

---

## Reading the Tenure Mix Display

On the dashboard, you'll see shorthand like: **1V 2E 2D 1T**

This means:
- 1 Veteran
- 2 Experienced
- 2 Developing
- 1 Training

The badge next to each restaurant shows the hourly experience score with color coding.

---

## Leader Performance Tracking

The system separately tracks **Managers** and **Shift Supervisors** to measure leadership effectiveness.

### What It Measures

For each leader, the system tracks:
- **Hours Worked** - Total hours on the clock during the period
- **Average Execution Grade** - Average hourly grade during their shifts
- **Overall Grade** - Letter grade (A+ through F)

### How Leader Grades Work

Leaders are graded based on how the restaurant performs during the hours they're working. If a leader is on the clock during a high-performing hour (good sales, speed, staffing), that contributes positively to their average.

### Leader Rankings

**Company-Wide Top 10**
- Shows the highest-performing leaders across all locations
- Ranked by average execution grade score

**Top Performer by Store**
- Shows the best-performing leader at each location
- Helps identify who's driving success at each unit

---

## Positions Tracked

The system identifies leadership positions from 7shifts:

| Position | Tracked as Leader? |
|----------|-------------------|
| Manager | Yes |
| Shift Supervisor | Yes |
| Team Member | No (tracked in tenure only) |
| Trainer | No (tracked in tenure only) |
| Other positions | No (tracked in tenure only) |

---

## Using This Data

### For Multi-Unit Managers

1. **Identify Experience Gaps** - Restaurants with consistently low experience scores may need veteran transfers or accelerated training
2. **Balance Peak Hours** - Ensure high-volume hours have adequate experienced staff
3. **Recognize Top Leaders** - Use leader rankings to identify and reward high performers
4. **Training Scheduling** - Schedule training employees during slower periods with veteran supervision

### For Restaurant Managers

1. **Schedule Strategically** - Put your strongest crews on your busiest hours
2. **Mentor Pairing** - Schedule trainees alongside veterans
3. **Track Development** - Watch team members progress through categories
4. **Self-Assessment** - Monitor your own leader performance ranking

---

## Data Sources

| Data Point | Source | Sync Frequency |
|------------|--------|----------------|
| Employee hire dates | 7shifts | Daily |
| Time punches | 7shifts | Hourly |
| Position/role | 7shifts time punches | Hourly |
| Hourly crew composition | Calculated | Hourly |

---

## Troubleshooting

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| Employee showing wrong tenure | Incorrect hire date in 7shifts | Update hire date in 7shifts |
| Missing employees from crew | No time punch recorded | Check 7shifts for clock-in |
| Leader not appearing in rankings | Position not set as Manager/Shift Supervisor | Update position in 7shifts |
| Score shows 0 | No crew data for that hour | Verify time punches exist |

---

## Key Takeaways

1. **Tenure is automatic** - Calculated from 7shifts hire dates
2. **Higher score = more experienced crew** - 100 is all veterans, 25 is all trainees
3. **Leaders are graded on restaurant performance** - During their working hours
4. **Use for scheduling** - Match crew experience to expected sales volume
5. **Watch progression** - Celebrate team members moving up categories

---

*Last Updated: February 2026*
