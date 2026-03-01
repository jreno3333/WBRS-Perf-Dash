# MWB Dashboard - Execution Scoring Guide

## Overview

The MWB Dashboard grades each hour of operation based on **five performance components**, with heavier weighting toward guest-facing metrics. Your **daily score** is the average of hourly scores plus any **bonus points** earned for exceptional daily performance.

**Component Weights:**

| Component | Weight | Category |
|-----------|--------|----------|
| Sales vs. Last Week | 30% | Guest-facing |
| Transactions vs. Last Week | 15% | Guest-facing |
| OSAT (Guest Satisfaction) | 30% | Guest-facing |
| Drive-Thru Speed | 15% | Operational |
| Staffing Level | 10% | Operational |

**Guest-facing metrics = 75%** | **Operational metrics = 25%**

---

## The Five Scoring Components

### 1. Sales Performance (30%)

Compares current hour's sales to the same hour last week, using a **graduated scale**.

| Variance vs. Last Week | Score |
|------------------------|-------|
| +10% or more | 100 |
| +5% to +10% | 95 |
| 0% to +5% | 90 |
| -5% to 0% | 80 |
| -10% to -5% | 60 |
| Below -10% | 40 |

**When data is missing:** No comparable last week data → score defaults to 90 (benefit of the doubt).

---

### 2. Transactions vs. Last Week (15%)

Compares hourly transaction count from POS to the same hour last week, using the **same graduated scale as sales**.

| Variance vs. Last Week | Score |
|------------------------|-------|
| +10% or more | 100 |
| +5% to +10% | 95 |
| 0% to +5% | 90 |
| -5% to 0% | 80 |
| -10% to -5% | 60 |
| Below -10% | 40 |

**When data is missing:** No comparable transaction data → component is skipped.

---

### 3. OSAT - Guest Satisfaction (30%)

Measures customer satisfaction percentage from survey data, using a **graduated scale**.

| OSAT % | Score |
|--------|-------|
| 90% or higher | 100 |
| 85% to 89% | 90 |
| 80% to 84% | 70 |
| 75% to 79% | 50 |
| Below 75% | 40 |

**When data is missing:** No survey data for the hour → component is skipped.

---

### 4. Drive-Thru Speed (15%)

Measures speed attainment (% of cars served under 6 minutes) via HME timers.

| Attainment | Score |
|------------|-------|
| 70% or more | 100 |
| 50% to 70% | 70 |
| Below 50% | 40 |

**Note:** Lane configuration changes can temporarily affect this metric. Speed carries a reduced weight (15%) to account for these operational exceptions.

**When data is missing:** No HME timer data → component is skipped.

---

### 5. Staffing Level (10%)

Compares actual employees on the clock to the labor model target.

| Condition | Score |
|-----------|-------|
| Within +/-1 of target | 100 |
| More than 1 over or under target | 60 |

**Sales Surge Exception:** If sales are **20%+ above last week**, understaffing is NOT penalized — you can't control unexpected demand.

**When data is missing:** No staffing data → component is skipped.

---

## Hourly Grade Calculation

1. **Collect available components** — only components with valid data are included
2. **Apply graduated scoring** — each component scores 0-100 based on the tables above
3. **Compute weighted average** — using the component weights (30/15/30/15/10)
4. **Convert to letter grade:**

| Score | Grade | Color |
|-------|-------|-------|
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

## Daily Bonus Points

Bonus points reward exceptional daily performance. They're added to the base score (average of hourly scores) at end of day, **capped at +8 points**.

| Bonus | Points | How to Earn |
|-------|--------|-------------|
| Perfect OSAT | +3 | 100% OSAT with 5+ surveys for the day |
| High-Volume OSAT | +2 | 85%+ OSAT with 10+ surveys for the day |
| Sales Growth | +2 | Daily sales 5%+ above same day last week |
| Transaction Growth | +2 | Transaction count 5%+ above same day last week |
| Recovery | +3 | Had 2+ hours graded C or below, but daily avg still B- or better |
| Consistency | +2 | No hour graded below B for the entire day |

**Notes:**
- Perfect OSAT and High-Volume OSAT are mutually exclusive — you earn whichever applies, not both
- Recovery kicker rewards resilience — a rough lunch rush doesn't have to ruin the whole day
- Minimum 4 graded hours required for Recovery and Consistency bonuses

**Daily Score = min(Base Score + Capped Bonus, 100)**

---

## Examples

### Example 1: Strong Day with Bonus

**Daily Summary:**
- Sales: +3% vs last week → Sales score: 90
- Transactions: +7% vs last week → Txn score: 95
- OSAT: 92% → OSAT score: 100
- Speed: 55% attainment → Speed score: 70
- Staffing: on target → Staffing score: 100

**Base Score:** (90×30 + 95×15 + 100×30 + 70×15 + 100×10) / 100 = **92.75**

**Bonuses earned:** Sales Growth (+2) + Consistency (+2) = **+4**

**Final Score:** min(92.75 + 4, 100) = **96.75 → Grade: A**

---

### Example 2: Recovery Day

**Hours graded:** 10am: C (75), 11am: D+ (68), 12pm: B (85), 1pm: A- (91), 2pm: A (95), 3pm: B+ (88), 4pm: A- (90)

**Base Score:** average = **84.6 (B)**

**Bonuses:** Recovery (+3) — had 2 hours at C or below but daily avg ≥ B-

**Final Score:** min(84.6 + 3, 100) = **87.6 → Grade: B+**

---

### Example 3: Sales Surge Exception

**Hour: 12 PM**
- Sales: +25% vs last week → Score: 100
- Transactions: +20% → Score: 100
- Speed: 55% attainment → Score: 70
- Staffing: 2 under target → **Score: 100** (surge exception!)
- OSAT: 88% → Score: 90

**Hourly Score:** (100×30 + 100×15 + 90×30 + 70×15 + 100×10) / 100 = **93.5 → Grade: A**

Without the surge exception, staffing would be 60 and the score would be 89.5 (B+).

---

## Key Takeaways

1. **Guest metrics matter most** — Sales, Transactions, and OSAT make up 75% of your score
2. **Graduated scoring rewards improvement** — every percentage point of growth counts
3. **Bonus points incentivize daily excellence** — aim for growth AND consistency
4. **Missing data doesn't hurt you** — the system only grades on what it can measure
5. **Unexpected rushes are forgiven** — 20%+ sales surge protects against understaffing
6. **Recovery is rewarded** — a bad hour doesn't have to define your day

---

## Troubleshooting

| Issue | Possible Cause | Solution |
|-------|---------------|----------|
| Grade shows "-" | No valid data for any component | Check if store is open, data syncing |
| Staffing always shows 0 | 7shifts not syncing | Contact support to verify time punch sync |
| No speed data | HME timer offline or no cars | Check timer connection |
| No transaction data | POS webhook not connected | Verify Xenial POS integration |
| First week shows neutral | Expected behavior | Grade will be more accurate after first full week |

---

*Last Updated: March 2026*
