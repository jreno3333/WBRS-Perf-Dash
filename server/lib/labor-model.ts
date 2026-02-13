const NON_PRODUCTION_BY_HOUR: Record<number, Record<string, number>> = {
  0: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  1: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  2: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  3: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  4: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  5: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  6: { pic: 0, porter: 0.5, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  7: { pic: 0, porter: 0.5, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  8: { pic: 0, porter: 0.5, prep: 0.5, training: 0, drAttendant: 0, curbside: 0 },
  9: { pic: 0, porter: 0.5, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  10: { pic: 0, porter: 0.5, prep: 0, training: 0, drAttendant: 0, curbside: 0.5 },
  11: { pic: 0.5, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0.5 },
  12: { pic: 0.5, porter: 0, prep: 0, training: 0, drAttendant: 0.5, curbside: 0.5 },
  13: { pic: 0.5, porter: 0, prep: 0, training: 0, drAttendant: 0.5, curbside: 0.5 },
  14: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  15: { pic: 0, porter: 0, prep: 0, training: 0.5, drAttendant: 0, curbside: 0 },
  16: { pic: 0, porter: 0, prep: 0.5, training: 0.5, drAttendant: 0, curbside: 0 },
  17: { pic: 0.5, porter: 0, prep: 0, training: 0, drAttendant: 0.5, curbside: 0.5 },
  18: { pic: 0.5, porter: 0, prep: 0, training: 0, drAttendant: 0.5, curbside: 0.5 },
  19: { pic: 0.5, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0.5 },
  20: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0.5 },
  21: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  22: { pic: 0, porter: 0, prep: 0, training: 0, drAttendant: 0, curbside: 0 },
  23: { pic: 0, porter: 0, prep: 0.5, training: 0, drAttendant: 0, curbside: 0 },
};

function getNonProductionStaff(hour: number): number {
  const staff = NON_PRODUCTION_BY_HOUR[hour] || NON_PRODUCTION_BY_HOUR[0];
  return Object.values(staff).reduce((sum, v) => sum + v, 0);
}

function isBreakfastHour(hour: number): boolean {
  return hour >= 6 && hour < 11;
}

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

function getProductionStaff(hour: number, hourlySales: number): number {
  if (hourlySales <= 0) return 0;
  const rampUp = isBreakfastHour(hour) ? BREAKFAST_RAMP_UP : NON_BREAKFAST_RAMP_UP;
  for (const tier of rampUp) {
    if (hourlySales <= tier.maxSales) {
      return tier.staff;
    }
  }
  return 30;
}

export function getStaffingBreakdown(hour: number, hourlySales: number) {
  const nonProd = getNonProductionStaff(hour);
  const prod = getProductionStaff(hour, hourlySales);
  return {
    nonProduction: nonProd,
    production: prod,
    total: nonProd + prod,
  };
}
