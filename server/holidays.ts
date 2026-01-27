import fedHolidays from '@18f/us-federal-holidays';

export interface HolidayInfo {
  name: string;
  date: string;
  dayOfWeek: string;
  isToday: boolean;
  isLastWeekComparisonDay: boolean;
}

export interface HolidayContext {
  todayHoliday: HolidayInfo | null;
  lastWeekHoliday: HolidayInfo | null;
  upcomingHolidays: HolidayInfo[];
}

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getDayOfWeek(date: Date): string {
  return dayNames[date.getDay()];
}

function getHolidayForDate(date: Date): HolidayInfo | null {
  const year = date.getFullYear();
  const holidays = fedHolidays.allForYear(year);
  const dateStr = formatDate(date);
  
  const holiday = holidays.find((h: any) => {
    const holidayDate = new Date(h.date);
    return formatDate(holidayDate) === dateStr;
  });
  
  if (holiday) {
    return {
      name: holiday.name,
      date: formatDate(new Date(holiday.date)),
      dayOfWeek: getDayOfWeek(new Date(holiday.date)),
      isToday: formatDate(date) === formatDate(new Date()),
      isLastWeekComparisonDay: false
    };
  }
  
  return null;
}

function getHolidayNearDate(date: Date, daysRange: number = 1): HolidayInfo | null {
  for (let i = -daysRange; i <= daysRange; i++) {
    const checkDate = new Date(date);
    checkDate.setDate(checkDate.getDate() + i);
    const holiday = getHolidayForDate(checkDate);
    if (holiday) return holiday;
  }
  return null;
}

export function getHolidayContext(targetDate: Date = new Date(), timezone: string = 'America/Chicago'): HolidayContext {
  // Normalize to the business timezone
  const targetDateStr = targetDate.toLocaleDateString('en-US', { timeZone: timezone });
  const today = new Date(targetDateStr);
  
  // Week-over-week comparison is day-of-week aligned (e.g., Tuesday to Tuesday)
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);
  
  const todayHoliday = getHolidayForDate(today);
  
  // Only show lastWeekHoliday if the holiday falls on the SAME comparison date
  // (i.e., the exact date 7 days ago, same day of week)
  let lastWeekHoliday = getHolidayForDate(lastWeek);
  if (lastWeekHoliday) {
    lastWeekHoliday.isLastWeekComparisonDay = true;
  }
  
  // Also check for holidays NEAR the comparison date (within 1-2 days) that might affect traffic
  // but don't set as the primary lastWeekHoliday unless it's on the exact comparison day
  if (!lastWeekHoliday) {
    const nearbyHoliday = getHolidayNearDate(lastWeek, 2);
    if (nearbyHoliday) {
      // Append context that this is nearby, not the exact comparison day
      nearbyHoliday.isLastWeekComparisonDay = false;
      nearbyHoliday.name = `${nearbyHoliday.name} (nearby)`;
      lastWeekHoliday = nearbyHoliday;
    }
  }
  
  const upcomingHolidays: HolidayInfo[] = [];
  const year = today.getFullYear();
  const allHolidays = fedHolidays.allForYear(year);
  
  for (const h of allHolidays) {
    const holidayDate = new Date(h.date);
    const diffDays = Math.ceil((holidayDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
    
    if (diffDays >= 0 && diffDays <= 30) {
      upcomingHolidays.push({
        name: h.name,
        date: formatDate(holidayDate),
        dayOfWeek: getDayOfWeek(holidayDate),
        isToday: diffDays === 0,
        isLastWeekComparisonDay: false
      });
    }
  }
  
  return {
    todayHoliday,
    lastWeekHoliday,
    upcomingHolidays
  };
}

export function getHolidayComparisonContext(date: Date): { thisYear: HolidayInfo | null; lastYear: HolidayInfo | null } {
  const thisYearHoliday = getHolidayNearDate(date, 0);
  
  let lastYearHoliday: HolidayInfo | null = null;
  if (thisYearHoliday) {
    const lastYear = date.getFullYear() - 1;
    const lastYearHolidays = fedHolidays.allForYear(lastYear);
    const matchingHoliday = lastYearHolidays.find((h: any) => h.name === thisYearHoliday.name);
    
    if (matchingHoliday) {
      const lastYearDate = new Date(matchingHoliday.date);
      lastYearHoliday = {
        name: matchingHoliday.name,
        date: formatDate(lastYearDate),
        dayOfWeek: getDayOfWeek(lastYearDate),
        isToday: false,
        isLastWeekComparisonDay: false
      };
    }
  }
  
  return { thisYear: thisYearHoliday, lastYear: lastYearHoliday };
}

export function getAllHolidaysForYear(year: number): HolidayInfo[] {
  const holidays = fedHolidays.allForYear(year);
  
  return holidays.map((h: any) => {
    const date = new Date(h.date);
    return {
      name: h.name,
      date: formatDate(date),
      dayOfWeek: getDayOfWeek(date),
      isToday: false,
      isLastWeekComparisonDay: false
    };
  });
}
