/**
 * MWB Labor Deployment Model
 * 
 * Total Required Staff = Non-Production Staff + Production Staff
 * 
 * Non-Production: Fixed hourly positions (PIC, Porter, Prep, Training, DR Attendant, Curbside)
 * Production: Sales-based staffing using different ramp-up charts for breakfast vs non-breakfast
 */

// Non-production role schedules (Model 1 - Sales Bands 1-6)
// Each role has designated hours during which they should be scheduled

interface HourlyNonProdStaff {
  pic: number;      // Person In Charge
  porter: number;   // Porter
  prep: number;     // Prep
  training: number; // Training
  drAttendant: number; // Dining Room Attendant
  curbside: number; // Curbside Attendant (using Medium model - 8 hrs/day)
}

// Non-production staff by hour (0-23)
// Based on Labor Model 1 with Medium Curbside variant
// PIC: 11 AM - 2 PM (hours 11,12,13) and 5 PM - 8 PM (hours 17,18,19) = 6 hrs
// Porter: 6 AM - 11 AM (hours 6,7,8,9,10) = 5 hrs
// Prep: 8 AM - 9 AM (hour 8), 4 PM - 5 PM (hour 16), 11 PM - 12 AM (hour 23) = 3 hrs
// Training: 3 PM - 5 PM (hours 15,16) = 2 hrs
// DR Attendant: 12 PM - 1:30 PM (hours 12,13), 5 PM - 6:30 PM (hours 17,18) = 3 hrs
// Curbside Med: 10 AM - 2 PM (hours 10,11,12,13), 5 PM - 9 PM (hours 17,18,19,20) = 8 hrs
const NON_PRODUCTION_BY_HOUR: Record<number, HourlyNonProdStaff> = {
  0: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  1: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  2: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  3: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  4: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  5: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  6: { pic: 0, porter: 1, prep: 0, training: 0, drAttendant: 0, curbside: 0 },  // Porter 6-11
  7: { pic: 0, porter: 1, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  8: { pic: 0, porter: 1, prep: 1, training: 0, drAttendant: 0, curbside: 0 },  // +Prep 8-9
  9: { pic: 0, porter: 1, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  10: { pic: 0, porter: 1, prep: 0, training: 0, drAttendant: 0, curbside: 1 }, // +Curbside 10-2
  11: { pic: 1, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 1 }, // PIC 11-2, Curbside
  12: { pic: 1, porter: 0, prep: 0, training: 0, drAttendant: 1, curbside: 1 }, // +DR 12-1:30
  13: { pic: 1, porter: 0, prep: 0, training: 0, drAttendant: 1, curbside: 1 }, // DR partial, Curbside ends at 2
  14: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 }, // Gap 2-3pm
  15: { pic: 0, porter: 0, prep: 0, training: 1, drAttendant: 0, curbside: 0 }, // Training 3-5
  16: { pic: 0, porter: 0, prep: 1, training: 1, drAttendant: 0, curbside: 0 }, // +Prep 4-5
  17: { pic: 1, porter: 0, prep: 0, training: 0, drAttendant: 1, curbside: 1 }, // PIC 5-8, DR 5-6:30, Curbside 5-9
  18: { pic: 1, porter: 0, prep: 0, training: 0, drAttendant: 1, curbside: 1 }, // DR partial ends 6:30
  19: { pic: 1, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 1 }, // PIC ends at 8pm
  20: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 1 }, // Curbside ends at 9pm
  21: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  22: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  23: { pic: 0, porter: 0, prep: 1, training: 0, drAttendant: 0, curbside: 0 }, // Prep 11pm-12am
};

/**
 * Get total non-production staff required for a given hour
 */
export function getNonProductionStaff(hour: number): number {
  const staff = NON_PRODUCTION_BY_HOUR[hour] || NON_PRODUCTION_BY_HOUR[0];
  return staff.pic + staff.porter + staff.prep + staff.training + staff.drAttendant + staff.curbside;
}

/**
 * Get breakdown of non-production staff for a given hour
 */
export function getNonProductionBreakdown(hour: number): HourlyNonProdStaff {
  return NON_PRODUCTION_BY_HOUR[hour] || NON_PRODUCTION_BY_HOUR[0];
}

// Breakfast Production Ramp-Up Chart (6am-11am)
// Maps sales thresholds to required production staff
const BREAKFAST_RAMP_UP: Array<{ maxSales: number; staff: number }> = [
  { maxSales: 118.87, staff: 3 },
  { maxSales: 237.76, staff: 4 },
  { maxSales: 356.67, staff: 5 },
  { maxSales: 475.55, staff: 6 },
  { maxSales: 594.45, staff: 7 },
  { maxSales: 686.95, staff: 8 },
  { maxSales: 779.42, staff: 9 },
  { maxSales: 871.93, staff: 10 },
  { maxSales: 964.42, staff: 11 },
  { maxSales: 1056.89, staff: 12 },
  { maxSales: 1149.40, staff: 13 },
  { maxSales: 1241.89, staff: 14 },
  { maxSales: 1334.39, staff: 15 },
  { maxSales: 1426.87, staff: 16 },
  { maxSales: 1519.37, staff: 17 },
  { maxSales: 1611.87, staff: 18 },
  { maxSales: 1704.37, staff: 19 },
  { maxSales: 1796.84, staff: 20 },
  { maxSales: 1889.35, staff: 21 },
  { maxSales: 1981.84, staff: 22 },
  { maxSales: 2074.32, staff: 23 },
  { maxSales: 2166.82, staff: 24 },
  { maxSales: 2259.32, staff: 25 },
  { maxSales: 2351.81, staff: 26 },
  { maxSales: 2444.29, staff: 27 },
  { maxSales: 2536.79, staff: 28 },
  { maxSales: 2629.28, staff: 29 },
  { maxSales: Infinity, staff: 30 },
];

// Non-Breakfast Production Ramp-Up Chart (11am-6am next day)
// Maps sales thresholds to required production staff
const NON_BREAKFAST_RAMP_UP: Array<{ maxSales: number; staff: number }> = [
  { maxSales: 154.53, staff: 3 },
  { maxSales: 309.09, staff: 4 },
  { maxSales: 463.67, staff: 5 },
  { maxSales: 618.23, staff: 6 },
  { maxSales: 772.79, staff: 7 },
  { maxSales: 893.04, staff: 8 },
  { maxSales: 1013.28, staff: 9 },
  { maxSales: 1133.53, staff: 10 },
  { maxSales: 1253.76, staff: 11 },
  { maxSales: 1374.01, staff: 12 },
  { maxSales: 1494.26, staff: 13 },
  { maxSales: 1614.50, staff: 14 },
  { maxSales: 1734.74, staff: 15 },
  { maxSales: 1854.98, staff: 16 },
  { maxSales: 1975.23, staff: 17 },
  { maxSales: 2095.47, staff: 18 },
  { maxSales: 2215.72, staff: 19 },
  { maxSales: 2335.95, staff: 20 },
  { maxSales: 2456.20, staff: 21 },
  { maxSales: 2576.44, staff: 22 },
  { maxSales: 2696.69, staff: 23 },
  { maxSales: 2816.93, staff: 24 },
  { maxSales: 2937.17, staff: 25 },
  { maxSales: 3057.42, staff: 26 },
  { maxSales: 3177.66, staff: 27 },
  { maxSales: 3297.90, staff: 28 },
  { maxSales: 3418.14, staff: 29 },
  { maxSales: Infinity, staff: 30 },
];

/**
 * Check if hour is during breakfast period (6am-11am)
 */
export function isBreakfastHour(hour: number): boolean {
  return hour >= 6 && hour < 11;
}

/**
 * Get production staff required based on hourly sales
 * Uses breakfast chart for 6am-11am, non-breakfast chart for all other hours
 */
export function getProductionStaff(hour: number, hourlySales: number): number {
  const rampUp = isBreakfastHour(hour) ? BREAKFAST_RAMP_UP : NON_BREAKFAST_RAMP_UP;
  
  for (const tier of rampUp) {
    if (hourlySales <= tier.maxSales) {
      return tier.staff;
    }
  }
  
  return 30; // Maximum staff
}

/**
 * Get total required staff for a given hour and sales amount
 * Total = Non-Production + Production
 */
export function getTotalRequiredStaff(hour: number, hourlySales: number): number {
  const nonProd = getNonProductionStaff(hour);
  const prod = getProductionStaff(hour, hourlySales);
  return nonProd + prod;
}

/**
 * Get staffing details for a given hour
 */
export function getStaffingDetails(hour: number, hourlySales: number) {
  const nonProd = getNonProductionStaff(hour);
  const prod = getProductionStaff(hour, hourlySales);
  const breakdown = getNonProductionBreakdown(hour);
  
  return {
    nonProduction: nonProd,
    production: prod,
    total: nonProd + prod,
    isBreakfast: isBreakfastHour(hour),
    breakdown,
  };
}
