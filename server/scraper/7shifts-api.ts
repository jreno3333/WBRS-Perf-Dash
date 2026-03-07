import { db, posDb } from '../db';
import { restaurants, dailySales, dailyLabor, hourlySales, hourlyLabor, scraperRuns, locationMapping, posOrders } from '@shared/schema';
import { eq, and, gte, lte, lt, sql } from 'drizzle-orm';
import { fromZonedTime, toZonedTime } from 'date-fns-tz';

interface SevenShiftsLocation {
  id: number;
  name: string;
  address: string;
  timezone: string;
  country: string;
  lat?: number;
  lng?: number;
  formatted_address?: string;
}

interface SevenShiftsSalesData {
  date: string;
  actual_sales: number;
  projected_sales: number;
  actual_labor_cost: number;
  projected_labor_cost: number;
  sales_per_labor_hour: number;
  labor_percent: number;
}

interface HourlyInterval {
  day: string;
  start: string;
  end: string;
  actual_sales: number;
  projected_sales: number;
  past_actual_sales: number;
  past_projected_sales: number;
  actual_labor: number;
  projected_labor: number;
}

interface DailyStatsResponse {
  data: {
    summary: {
      current_actual_sales: number;
      current_projected_sales: number;
      past_actual_sales: number;
      past_projected_sales: number;
    };
    intervals: HourlyInterval[];
  };
}

interface TimePunch {
  id: number;
  user_id: number;
  location_id: number;
  department_id: number;
  role_id: number;
  clocked_in: string;
  clocked_out: string | null;
  approved: boolean;
  hourly_wage: number;
  breaks: { in: string; out: string | null; paid: boolean }[];
}

interface TimePunchesResponse {
  data: TimePunch[];
  meta: {
    cursor?: {
      next?: string;
    };
  };
}

interface Role {
  id: number;
  name: string;
  location_id: number;
  department_id: number;
}

interface RolesResponse {
  data: Role[];
}

interface LaborByHour {
  totalHours: number;
  byPosition: Record<string, number>; // e.g., { "Grill": 2.5, "Counter": 1.5 }
  quarters: { q0: number; q1: number; q2: number; q3: number }; // Labor hours per 15-min window
}

interface ScheduledShift {
  id: number;
  user_id: number;
  location_id: number;
  department_id: number;
  role_id: number;
  start: string;  // ISO timestamp
  end: string;    // ISO timestamp
}

interface ShiftsResponse {
  data: ScheduledShift[];
  meta: {
    cursor?: {
      next?: string;
    };
  };
}

// User/Employee data from 7shifts
interface SevenShiftsUser {
  id: number;
  company_id: number;
  first_name: string;
  last_name: string;
  email: string | null;
  active: boolean;
  hire_date: string | null; // YYYY-MM-DD format or null
  invited: string | null; // ISO timestamp when invited to 7shifts (fallback for hire_date)
  type: string; // employee, manager, asst_manager, employer
}

interface UsersResponse {
  data: { id?: number; user?: SevenShiftsUser }[] | SevenShiftsUser[];
  meta: {
    cursor?: {
      current: string | null;
      prev: string | null;
      next: string | null;
      count: number;
    };
  };
}

interface ApiConfig {
  accessToken: string;
  companyId?: number;
}

export class SevenShiftsAPI {
  private baseUrl = 'https://api.7shifts.com';
  private accessToken: string;
  private companyId: number | null = null;

  constructor(config: ApiConfig) {
    this.accessToken = config.accessToken;
    this.companyId = config.companyId || null;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`7shifts API error ${response.status}: ${errorText}`);
    }

    return response.json();
  }

  async getCompany(): Promise<{ id: number; name: string }> {
    const response = await this.request<any>('/v2/whoami');
    
    const users = response.data?.users || [];
    if (users.length === 0) {
      throw new Error('No users found in whoami response');
    }
    
    const companyId = users[0].company_id;
    console.log(`Found company_id: ${companyId} for user: ${users[0].first_name} ${users[0].last_name}`);
    
    this.companyId = companyId;
    return { id: companyId, name: `Company ${companyId}` };
  }

  async getLocations(): Promise<SevenShiftsLocation[]> {
    if (!this.companyId) {
      await this.getCompany();
    }
    
    console.log(`Fetching locations for company ${this.companyId}...`);
    const response = await this.request<any>(
      `/v2/company/${this.companyId}/locations`
    );
    console.log(`Locations response:`, JSON.stringify(response, null, 2).substring(0, 1000));
    
    return response.data || response || [];
  }

  async getDailySalesReport(locationId: number, startDate: string, endDate: string): Promise<SevenShiftsSalesData[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    try {
      const response = await this.request<any>(
        `/v2/reports/daily_sales_and_labor?location_id=${locationId}&start_date=${startDate}&end_date=${endDate}`
      );
      return response.data || [];
    } catch (error) {
      console.error(`Error fetching sales for location ${locationId}:`, error);
      return [];
    }
  }

  async getHourlySales(locationId: number, date: string): Promise<HourlyInterval[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    try {
      const response = await this.request<DailyStatsResponse>(
        `/v2/company/${this.companyId}/location/${locationId}/daily_stats?date=${date}`
      );
      return response.data?.intervals || [];
    } catch (error) {
      console.error(`Error fetching hourly sales for location ${locationId}:`, error);
      return [];
    }
  }

  // Fetch time punches for a location on a specific date
  // Includes punches that started before the target date but continued into it
  // timezone parameter is optional - if provided, uses proper UTC offset calculation
  async getTimePunches(locationId: number, date: string, timezone?: string): Promise<TimePunch[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    try {
      // Calculate proper UTC range based on location's timezone
      // For Eastern stores (UTC-5), midnight local = 5am UTC
      // For Central stores (UTC-6), midnight local = 6am UTC
      const [year, month, day] = date.split('-').map(Number);
      
      // Determine UTC offset based on timezone
      // In winter: EST is UTC-5, CST is UTC-6
      // We use a simple offset check (more robust would use a library like date-fns-tz)
      const isEastern = timezone?.includes('New_York') || timezone?.includes('Eastern');
      const utcOffset = isEastern ? 5 : 6; // Hours to add to local midnight to get UTC
      
      // Calculate start of target day in UTC (midnight local time converted to UTC)
      // Then go back 4 hours to catch overnight shifts
      const startOfDayUTC = new Date(Date.UTC(year, month - 1, day, utcOffset, 0, 0));
      const startDate = new Date(startOfDayUTC.getTime() - 4 * 60 * 60 * 1000);
      
      // Calculate end of target day in UTC (11:59:59pm local time converted to UTC)
      // Then add 4 hours to catch late punches
      const endOfDayUTC = new Date(Date.UTC(year, month - 1, day, utcOffset + 23, 59, 59));
      const endDate = new Date(endOfDayUTC.getTime() + 4 * 60 * 60 * 1000);
      
      const startDateStr = startDate.toISOString().replace('.000Z', '');
      const endDateStr = endDate.toISOString().replace('.000Z', '');
      
      // Fetch punches where clocked_in is within range
      // Add limit=500 to get more results (7shifts API defaults to low limit)
      const response = await this.request<TimePunchesResponse>(
        `/v2/company/${this.companyId}/time_punches?location_id=${locationId}&clocked_in[gte]=${startDateStr}&clocked_in[lte]=${endDateStr}&limit=500`
      );
      
      return response.data || [];
    } catch (error) {
      console.error(`Error fetching time punches for location ${locationId}:`, error);
      return [];
    }
  }

  // Fetch all roles for a location to map role_id to role name
  async getRoles(locationId: number): Promise<Map<number, string>> {
    if (!this.companyId) {
      await this.getCompany();
    }

    const roleMap = new Map<number, string>();
    
    try {
      const response = await this.request<RolesResponse>(
        `/v2/company/${this.companyId}/roles?location_id=${locationId}&limit=100`
      );
      
      for (const role of response.data || []) {
        roleMap.set(role.id, role.name);
      }
      
      return roleMap;
    } catch (error) {
      console.error(`Error fetching roles for location ${locationId}:`, error);
      return roleMap;
    }
  }

  // Fetch scheduled shifts for a location on a specific date
  // Returns scheduled shifts with role information to check for operators
  async getScheduledShifts(locationId: number, date: string): Promise<ScheduledShift[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    const allShifts: ScheduledShift[] = [];
    
    try {
      // Fetch shifts for the target date
      const startDate = `${date}T00:00:00`;
      const endDate = `${date}T23:59:59`;
      
      const response = await this.request<ShiftsResponse>(
        `/v2/company/${this.companyId}/shifts?location_id=${locationId}&start[gte]=${startDate}&end[lte]=${endDate}&limit=500`
      );
      
      allShifts.push(...(response.data || []));
      
      return allShifts;
    } catch (error) {
      console.error(`Error fetching scheduled shifts for location ${locationId}:`, error);
      return allShifts;
    }
  }

  // Fetch all users/employees for a location with hire_date for crew experience tracking
  async getUsers(locationId?: number): Promise<SevenShiftsUser[]> {
    if (!this.companyId) {
      await this.getCompany();
    }

    const allUsers: SevenShiftsUser[] = [];
    let cursor: string | null = null;
    
    try {
      // Paginate through all users
      do {
        let url = `/v2/company/${this.companyId}/users?limit=100`;
        if (locationId) {
          url += `&location_id=${locationId}`;
        }
        if (cursor) {
          url += `&cursor=${cursor}`;
        }
        
        const response = await this.request<UsersResponse>(url);
        
        // 7shifts API may return users in different formats
        const users = response.data || [];
        for (const item of users) {
          // Handle both { user: {...} } and direct user object formats
          const user = (item as any).user || item;
          if (user && user.id) {
            allUsers.push({
              id: user.id,
              company_id: user.company_id,
              first_name: user.first_name,
              last_name: user.last_name,
              email: user.email,
              active: user.active,
              hire_date: user.hire_date,
              invited: user.invited, // Fallback for hire_date
              type: user.type,
            });
          }
        }
        
        cursor = response.meta?.cursor?.next || null;
      } while (cursor);
      
      console.log(`[7shifts] Fetched ${allUsers.length} users${locationId ? ` for location ${locationId}` : ''}`);
      return allUsers;
    } catch (error) {
      console.error(`Error fetching users:`, error);
      return allUsers;
    }
  }

  // Get users who were working during a specific hour based on time punches
  getUsersWorkingHour(timePunches: TimePunch[], targetHour: number, targetDate: string, timezone: string): number[] {
    const userIds: number[] = [];
    
    for (const punch of timePunches) {
      if (!punch.clocked_in) continue;
      
      const clockedIn = new Date(punch.clocked_in);
      const clockedOut = punch.clocked_out ? new Date(punch.clocked_out) : new Date(); // Treat still clocked in as now
      
      // Convert to target timezone
      const clockInHour = parseInt(clockedIn.toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }));
      const clockOutHour = parseInt(clockedOut.toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }));
      const clockInDate = clockedIn.toLocaleDateString('en-CA', { timeZone: timezone });
      const clockOutDate = clockedOut.toLocaleDateString('en-CA', { timeZone: timezone });
      
      // Check if this punch overlaps with the target hour on the target date
      const punchStartsBeforeOrDuringHour = (clockInDate < targetDate) || 
        (clockInDate === targetDate && clockInHour <= targetHour);
      const punchEndsAfterOrDuringHour = (clockOutDate > targetDate) || 
        (clockOutDate === targetDate && clockOutHour >= targetHour);
      
      if (punchStartsBeforeOrDuringHour && punchEndsAfterOrDuringHour) {
        if (!userIds.includes(punch.user_id)) {
          userIds.push(punch.user_id);
        }
      }
    }
    
    return userIds;
  }

  // Get users with their positions working during a specific hour
  // Only returns employees who were ACTUALLY clocked in during the target hour
  // Uses precise UTC interval overlap to handle boundary conditions correctly
  // (e.g., someone clocking out at exactly 09:00 is NOT counted for 9:00-10:00 hour)
  getUsersWithPositionsWorkingHour(timePunches: TimePunch[], roleMap: Map<number, string>, targetHour: number, targetDate: string, timezone: string): { userId: number; position: string }[] {
    const users: { userId: number; position: string }[] = [];
    const seenUserIds = new Set<number>();
    
    // Get current time in the target timezone
    const now = new Date();
    const currentLocalDate = now.toLocaleDateString('en-CA', { timeZone: timezone });
    const currentLocalHour = parseInt(now.toLocaleString('en-US', { timeZone: timezone, hour: '2-digit', hour12: false }));
    
    // Don't return anyone for future hours (hours that haven't happened yet)
    if (targetDate > currentLocalDate || (targetDate === currentLocalDate && targetHour > currentLocalHour)) {
      return [];
    }
    
    // Define the target hour interval using precise UTC timestamps
    // Hour 9 = 09:00:00 to 09:59:59 (we use 10:00 as exclusive end for comparison)
    const hourStartLocal = `${targetDate}T${targetHour.toString().padStart(2, '0')}:00:00`;
    const nextHour = (targetHour + 1) % 24;
    const nextHourDate = targetHour === 23 ? new Date(new Date(targetDate).getTime() + 86400000).toISOString().split('T')[0] : targetDate;
    const hourEndLocal = `${nextHourDate}T${nextHour.toString().padStart(2, '0')}:00:00`;
    
    // Convert to UTC timestamps for precise comparison
    const hourStartUtc = fromZonedTime(hourStartLocal, timezone);
    const hourEndUtc = fromZonedTime(hourEndLocal, timezone);
    
    for (const punch of timePunches) {
      if (!punch.clocked_in) continue;
      
      const clockedIn = new Date(punch.clocked_in);
      
      // For employees still clocked in, use current time
      // For historical dates, if still open, cap at end of target date
      let clockedOut: Date;
      if (punch.clocked_out) {
        clockedOut = new Date(punch.clocked_out);
      } else if (targetDate < currentLocalDate) {
        // Historical date with open punch - cap at end of target date
        clockedOut = fromZonedTime(`${targetDate}T23:59:59`, timezone);
      } else {
        // Current date with open punch - use now
        clockedOut = now;
      }
      
      // Precise interval overlap check:
      // Punch overlaps the hour if: punchStart < hourEnd AND punchEnd > hourStart
      // This correctly handles boundary cases (clock out at 09:00 does NOT overlap 09:00-10:00)
      const punchOverlapsHour = clockedIn < hourEndUtc && clockedOut > hourStartUtc;
      
      if (punchOverlapsHour) {
        if (!seenUserIds.has(punch.user_id)) {
          seenUserIds.add(punch.user_id);
          const position = roleMap.get(punch.role_id) || `Role ${punch.role_id}`;
          users.push({ userId: punch.user_id, position });
        }
      }
    }
    
    return users;
  }

  // Get user IDs of all users who have the "Operator" role assigned at a location.
  // This uses the 7shifts role_assignments concept: a user can have the Operator role
  // assigned even if their individual shifts are under a different role (e.g., Manager).
  async getOperatorUserIds(locationId: number): Promise<Set<number>> {
    const roleMap = await this.getRoles(locationId);
    const operatorRoleIds: number[] = [];
    for (const [roleId, roleName] of roleMap) {
      if (roleName.toLowerCase().includes('operator')) {
        operatorRoleIds.push(roleId);
      }
    }

    if (operatorRoleIds.length === 0) {
      return new Set();
    }

    // Fetch users filtered by each operator role ID
    const operatorUserIds = new Set<number>();
    for (const roleId of operatorRoleIds) {
      try {
        let cursor: string | null = null;
        do {
          let url = `/v2/company/${this.companyId}/users?location_id=${locationId}&role_id=${roleId}&limit=100`;
          if (cursor) {
            url += `&cursor=${cursor}`;
          }
          const response = await this.request<UsersResponse>(url);
          for (const item of (response.data || [])) {
            const user = (item as any).user || item;
            if (user?.id && user.active !== false) {
              operatorUserIds.add(user.id);
            }
          }
          cursor = response.meta?.cursor?.next || null;
        } while (cursor);
      } catch (error) {
        console.error(`[7shifts] Error fetching operator users for role ${roleId}:`, error);
      }
    }

    console.log(`[7shifts] Found ${operatorUserIds.size} operator users at location ${locationId}`);
    return operatorUserIds;
  }

  // Check if an operator is scheduled for a specific hour
  // Checks both: (1) shifts explicitly under an "Operator" role, and
  // (2) any shift belonging to a user who has the Operator role assigned
  hasOperatorScheduledForHour(shifts: ScheduledShift[], roleMap: Map<number, string>, hour: number, timezone: string, date: string, operatorUserIds?: Set<number>): boolean {
    for (const shift of shifts) {
      const roleName = roleMap.get(shift.role_id)?.toLowerCase() || '';
      const isOperatorRole = roleName.includes('operator');
      const isOperatorUser = operatorUserIds?.has(shift.user_id) ?? false;

      if (isOperatorRole || isOperatorUser) {
        // Check if this shift covers the given hour
        const shiftStart = new Date(shift.start);
        const shiftEnd = new Date(shift.end);

        // Convert hour to the same timezone for comparison
        const hourStart = fromZonedTime(`${date}T${hour.toString().padStart(2, '0')}:00:00`, timezone);
        const hourEnd = fromZonedTime(`${date}T${hour.toString().padStart(2, '0')}:59:59`, timezone);

        // Check if shift overlaps with this hour
        if (shiftStart <= hourEnd && shiftEnd >= hourStart) {
          return true;
        }
      }
    }
    return false;
  }

  // Calculate total labor hours worked for each hour based on time punches
  // Returns fractional hours (e.g., 5.6 hours) representing the sum of all employee time worked
  // Uses date string and location timezone to determine target day boundaries
  // Timezone parameter ensures hour boundaries match the location's local time
  getLaborHoursPerHour(punches: TimePunch[], date: string, timezone: string): Map<number, number> {
    const laborHoursByHour = new Map<number, number>();
    
    // Initialize all hours to 0
    for (let h = 0; h < 24; h++) {
      laborHoursByHour.set(h, 0);
    }
    
    // Use fromZonedTime with string-based date creation to avoid server timezone issues
    // This approach creates a string that represents the local time in the target timezone
    // and then converts it to UTC for comparison with punch times
    const startOfDayUTC = fromZonedTime(`${date}T00:00:00`, timezone);
    const endOfDayUTC = fromZonedTime(`${date}T23:59:59.999`, timezone);
    
    // For each punch, calculate the labor hours contributed to each hour
    for (const punch of punches) {
      // 7shifts returns punch times as ISO strings with timezone offset
      // Parsing with new Date() gives us UTC time
      let clockIn = new Date(punch.clocked_in);
      
      // Clamp clock out to end of target day for open punches
      let clockOut: Date;
      if (punch.clocked_out) {
        clockOut = new Date(punch.clocked_out);
      } else {
        // Still on clock - clamp to end of target day or current time, whichever is earlier
        const now = new Date();
        clockOut = now < endOfDayUTC ? now : endOfDayUTC;
      }
      
      // Skip if punch ended before start of day or started after end of day
      if (clockOut < startOfDayUTC || clockIn > endOfDayUTC) {
        continue;
      }
      
      // Clamp punch times to the target day window to avoid counting hours outside the day
      // This is critical for overnight shifts that start before midnight
      if (clockIn < startOfDayUTC) {
        clockIn = startOfDayUTC;
      }
      if (clockOut > endOfDayUTC) {
        clockOut = endOfDayUTC;
      }
      
      // Calculate fractional hours worked for each hour interval
      for (let h = 0; h < 24; h++) {
        // Create hour boundaries in local timezone using string format, then convert to UTC
        const hourStr = h.toString().padStart(2, '0');
        const hourStartUTC = fromZonedTime(`${date}T${hourStr}:00:00`, timezone);
        // Use exact hour boundary (not 59:59.999) for accurate fraction calculation
        const nextHourStr = (h + 1).toString().padStart(2, '0');
        const hourEndUTC = h < 23 
          ? fromZonedTime(`${date}T${nextHourStr}:00:00`, timezone)
          : new Date(fromZonedTime(`${date}T23:59:59.999`, timezone).getTime() + 1);
        
        // Check if there's any overlap
        if (clockIn < hourEndUTC && clockOut > hourStartUTC) {
          // Calculate the actual overlap in this hour
          const overlapStart = clockIn > hourStartUTC ? clockIn : hourStartUTC;
          const overlapEnd = clockOut < hourEndUTC ? clockOut : hourEndUTC;
          
          // Calculate fraction of hour worked (in hours, e.g., 0.5 for 30 minutes)
          const overlapMs = overlapEnd.getTime() - overlapStart.getTime();
          const hoursWorked = overlapMs / (1000 * 60 * 60); // Convert ms to hours
          
          laborHoursByHour.set(h, (laborHoursByHour.get(h) || 0) + hoursWorked);
        }
      }
    }
    
    return laborHoursByHour;
  }

  // Calculate labor hours per hour WITH position breakdown
  // Returns total hours AND breakdown by role/position name
  getLaborHoursWithPositions(
    punches: TimePunch[], 
    date: string, 
    timezone: string, 
    roleMap: Map<number, string>
  ): Map<number, LaborByHour> {
    const laborByHour = new Map<number, LaborByHour>();
    
    // Initialize all hours
    for (let h = 0; h < 24; h++) {
      laborByHour.set(h, { totalHours: 0, byPosition: {}, quarters: { q0: 0, q1: 0, q2: 0, q3: 0 } });
    }
    
    const startOfDayUTC = fromZonedTime(`${date}T00:00:00`, timezone);
    const endOfDayUTC = fromZonedTime(`${date}T23:59:59.999`, timezone);
    const now = new Date();
    
    // DEBUG: Log for East Ridge timezone to diagnose open punch calculation
    const isEastRidge = timezone === 'America/New_York';
    if (isEastRidge && punches.length > 50) {
      const openPunches = punches.filter(p => !p.clocked_out);
      console.log(`[LABOR DEBUG] Date: ${date}, TZ: ${timezone}`);
      console.log(`[LABOR DEBUG] startOfDayUTC: ${startOfDayUTC.toISOString()}`);
      console.log(`[LABOR DEBUG] endOfDayUTC: ${endOfDayUTC.toISOString()}`);
      console.log(`[LABOR DEBUG] now: ${now.toISOString()}`);
      console.log(`[LABOR DEBUG] Open punches: ${openPunches.length}`);
      if (openPunches.length > 0) {
        console.log(`[LABOR DEBUG] First open punch clocked_in: ${openPunches[0].clocked_in}`);
      }
    }
    
    for (const punch of punches) {
      let clockIn = new Date(punch.clocked_in);
      
      let clockOut: Date;
      if (punch.clocked_out) {
        clockOut = new Date(punch.clocked_out);
      } else {
        const now = new Date();
        clockOut = now < endOfDayUTC ? now : endOfDayUTC;
      }
      
      if (clockOut < startOfDayUTC || clockIn > endOfDayUTC) {
        continue;
      }
      
      if (clockIn < startOfDayUTC) clockIn = startOfDayUTC;
      if (clockOut > endOfDayUTC) clockOut = endOfDayUTC;
      
      // Get position name from role_id
      const positionName = roleMap.get(punch.role_id) || `Role ${punch.role_id}`;
      
      for (let h = 0; h < 24; h++) {
        const hourStr = h.toString().padStart(2, '0');
        const hourStartUTC = fromZonedTime(`${date}T${hourStr}:00:00`, timezone);
        const nextHourStr = (h + 1).toString().padStart(2, '0');
        const hourEndUTC = h < 23 
          ? fromZonedTime(`${date}T${nextHourStr}:00:00`, timezone)
          : new Date(fromZonedTime(`${date}T23:59:59.999`, timezone).getTime() + 1);
        
        if (clockIn < hourEndUTC && clockOut > hourStartUTC) {
          const overlapStart = clockIn > hourStartUTC ? clockIn : hourStartUTC;
          const overlapEnd = clockOut < hourEndUTC ? clockOut : hourEndUTC;
          const overlapMs = overlapEnd.getTime() - overlapStart.getTime();
          const hoursWorked = overlapMs / (1000 * 60 * 60);

          const hourData = laborByHour.get(h)!;
          hourData.totalHours += hoursWorked;
          hourData.byPosition[positionName] = (hourData.byPosition[positionName] || 0) + hoursWorked;

          // Distribute into 15-min quarters within this hour
          for (let q = 0; q < 4; q++) {
            const qStartMs = hourStartUTC.getTime() + q * 15 * 60 * 1000;
            const qEndMs = qStartMs + 15 * 60 * 1000;
            if (overlapStart.getTime() < qEndMs && overlapEnd.getTime() > qStartMs) {
              const qOverlapStart = Math.max(overlapStart.getTime(), qStartMs);
              const qOverlapEnd = Math.min(overlapEnd.getTime(), qEndMs);
              const qHours = (qOverlapEnd - qOverlapStart) / (1000 * 60 * 60);
              const qKey = `q${q}` as 'q0' | 'q1' | 'q2' | 'q3';
              hourData.quarters[qKey] += qHours;
            }
          }
        }
      }
    }
    
    return laborByHour;
  }
}

export async function syncLocationsFromAPI(): Promise<number> {
  const accessToken = process.env.SEVENSHIFTS_API_TOKEN;
  
  if (!accessToken) {
    throw new Error('SEVENSHIFTS_API_TOKEN not configured');
  }

  const api = new SevenShiftsAPI({ accessToken });
  const locations = await api.getLocations();
  
  let syncedCount = 0;
  
  for (const location of locations) {
    const existingRestaurant = await db.query.restaurants.findFirst({
      where: eq(restaurants.name, location.name),
    });
    
    if (!existingRestaurant) {
      await db.insert(restaurants).values({
        name: location.name,
        timezone: location.timezone || 'America/Chicago',
        isActive: true,
        latitude: location.lat ? String(location.lat) : null,
        longitude: location.lng ? String(location.lng) : null,
        address: location.formatted_address || null,
      });
      console.log(`Created restaurant: ${location.name}`);
    } else {
      // Always update lat/lng and address from 7shifts if available
      const needsUpdate = 
        (location.lat && String(location.lat) !== existingRestaurant.latitude) ||
        (location.lng && String(location.lng) !== existingRestaurant.longitude) ||
        (location.formatted_address && location.formatted_address !== existingRestaurant.address);
      
      if (needsUpdate) {
        await db.update(restaurants)
          .set({
            latitude: location.lat ? String(location.lat) : existingRestaurant.latitude,
            longitude: location.lng ? String(location.lng) : existingRestaurant.longitude,
            address: location.formatted_address || existingRestaurant.address,
          })
          .where(eq(restaurants.id, existingRestaurant.id));
        console.log(`Updated coordinates for: ${location.name}`);
      }
    }
    syncedCount++;
  }
  
  console.log(`Synced ${syncedCount} locations from 7shifts`);
  return syncedCount;
}

export async function fetchSalesFromAPI(date?: Date): Promise<{ success: boolean; recordsScraped: number; error?: string }> {
  const accessToken = process.env.SEVENSHIFTS_API_TOKEN;
  
  if (!accessToken) {
    return {
      success: false,
      recordsScraped: 0,
      error: 'SEVENSHIFTS_API_TOKEN not configured',
    };
  }

  const [scraperRun] = await db.insert(scraperRuns).values({
    status: 'running',
  }).returning();

  try {
    const api = new SevenShiftsAPI({ accessToken });
    
    console.log('Fetching company info...');
    const company = await api.getCompany();
    console.log(`Company: ${company.name} (ID: ${company.id})`);
    
    console.log('Fetching locations...');
    const locations = await api.getLocations();
    console.log(`Found ${locations.length} locations`);
    
    // Use Central timezone to determine "today" since server runs in UTC
    // This ensures 9 PM ET / 8 PM CT on Jan 19 syncs Jan 19 data, not Jan 20
    let targetDate: Date;
    let dateStr: string;
    
    if (date) {
      targetDate = date;
      dateStr = date.toISOString().split('T')[0];
    } else {
      // Get today's date in Central timezone (handles DST automatically)
      dateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      // Create a Date object for noon UTC on the target date
      // Using noon UTC avoids timezone offset issues with midnight boundaries
      // The date portion will match the Central timezone date
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    }
    
    let recordsScraped = 0;
    
    for (const location of locations) {
      console.log(`Fetching sales for ${location.name}...`);
      
      let restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.name, location.name),
      });
      
      if (!restaurant) {
        const [newRestaurant] = await db.insert(restaurants).values({
          name: location.name,
          timezone: location.timezone || 'America/Chicago',
          isActive: true,
        }).returning();
        restaurant = newRestaurant;
        console.log(`Created restaurant: ${location.name}`);
      }
      
      const salesData = await api.getDailySalesReport(location.id, dateStr, dateStr);
      
      if (salesData.length > 0) {
        const dayData = salesData[0];
        
        const startOfDay = new Date(targetDate);
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date(targetDate);
        endOfDay.setHours(23, 59, 59, 999);
        
        const existing = await db.query.dailySales.findFirst({
          where: and(
            eq(dailySales.restaurantId, restaurant.id),
            gte(dailySales.salesDate, startOfDay),
            lt(dailySales.salesDate, endOfDay)
          ),
        });
        
        if (existing) {
          await db.update(dailySales)
            .set({
              totalSales: dayData.actual_sales.toString(),
              vsProjected: (dayData.actual_sales - dayData.projected_sales).toString(),
              scrapedAt: new Date(),
            })
            .where(eq(dailySales.id, existing.id));
        } else {
          await db.insert(dailySales).values({
            restaurantId: restaurant.id,
            locationCode: location.id.toString(),
            salesDate: targetDate,
            totalSales: dayData.actual_sales.toString(),
            vsProjected: (dayData.actual_sales - dayData.projected_sales).toString(),
          });
        }
        
        // Store labor data in separate dailyLabor table
        const laborDateStr = targetDate.toISOString().split('T')[0];
        const existingLabor = await db.select().from(dailyLabor).where(
          and(
            eq(dailyLabor.restaurantId, restaurant.id),
            eq(dailyLabor.date, laborDateStr),
          )
        ).limit(1);
        
        if (existingLabor.length > 0) {
          await db.update(dailyLabor)
            .set({
              laborPercent: (dayData.labor_percent * 100).toString(),
              projectedLaborCost: (dayData.projected_labor_cost / 100).toFixed(2),
              syncedAt: new Date(),
            })
            .where(eq(dailyLabor.id, existingLabor[0].id));
        } else {
          await db.insert(dailyLabor).values({
            restaurantId: restaurant.id,
            date: laborDateStr,
            laborPercent: (dayData.labor_percent * 100).toString(),
            projectedLaborCost: (dayData.projected_labor_cost / 100).toFixed(2),
          });
        }
        
        recordsScraped++;
        console.log(`Saved sales for ${location.name}: $${(dayData.actual_sales / 100).toFixed(2)}`);
      }
    }
    
    await db.update(scraperRuns)
      .set({
        status: 'success',
        completedAt: new Date(),
        recordsScraped,
      })
      .where(eq(scraperRuns.id, scraperRun.id));
    
    console.log(`API sync completed. ${recordsScraped} records saved.`);
    return { success: true, recordsScraped };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    await db.update(scraperRuns)
      .set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage,
      })
      .where(eq(scraperRuns.id, scraperRun.id));
    
    console.error('API sync failed:', errorMessage);
    return { success: false, recordsScraped: 0, error: errorMessage };
  }
}

export async function fetchHistoricalSales(days: number = 7): Promise<void> {
  console.log(`Fetching ${days} days of historical sales data...`);
  
  for (let i = 0; i < days; i++) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    
    console.log(`Fetching data for ${date.toISOString().split('T')[0]}...`);
    const result = await fetchSalesFromAPI(date);
    
    if (!result.success) {
      console.error(`Failed to fetch ${date.toISOString().split('T')[0]}: ${result.error}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 300)); // Reduced delay for faster seeding
  }
  
  console.log('Historical data fetch complete');
}

export async function fetchHistoricalHourlySales(days: number = 8): Promise<void> {
  console.log(`Fetching ${days} days of historical hourly sales data...`);
  
  for (let i = 0; i < days; i++) {
    // Get date string in Central timezone
    const now = new Date();
    now.setDate(now.getDate() - i);
    const dateStr = new Intl.DateTimeFormat('en-CA', { 
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(now);
    
    // Create date at noon UTC to ensure consistent date matching
    const normalizedDate = new Date(dateStr + 'T12:00:00.000Z');
    
    console.log(`Fetching hourly data for ${dateStr}...`);
    const result = await fetchHourlySalesFromAPI(normalizedDate);
    
    if (!result.success) {
      console.error(`Failed to fetch hourly ${dateStr}: ${result.error}`);
    }
    
    await new Promise(resolve => setTimeout(resolve, 500)); // Reduced delay for faster seeding
  }
  
  console.log('Historical hourly data fetch complete');
}

export async function fetchHourlySalesFromAPI(date?: Date): Promise<{ success: boolean; recordsScraped: number; error?: string }> {
  const accessToken = process.env.SEVENSHIFTS_API_TOKEN;
  
  if (!accessToken) {
    return {
      success: false,
      recordsScraped: 0,
      error: 'SEVENSHIFTS_API_TOKEN not configured',
    };
  }

  try {
    const api = new SevenShiftsAPI({ accessToken });
    await api.getCompany();
    
    const locations = await api.getLocations();
    
    // Use Central timezone to determine "today" since server runs in UTC
    // This ensures 9 PM ET / 8 PM CT on Jan 19 syncs Jan 19 data, not Jan 20
    let targetDate: Date;
    let dateStr: string;
    
    if (date) {
      // Normalize incoming date to noon UTC for consistent date matching
      dateStr = date.toISOString().split('T')[0];
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    } else {
      // Get today's date in Central timezone (handles DST automatically)
      dateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      // Create a Date object for noon UTC on the target date
      // Using noon UTC avoids timezone offset issues with midnight boundaries
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    }
    
    let recordsScraped = 0;
    
    // Preload location mappings once for POS store number lookups
    const allMappings = await db.select().from(locationMapping);
    const xenialMappingByRestaurantId = new Map<string, string>();
    for (const m of allMappings) {
      if (m.restaurantId && m.xenialStoreNumber) {
        xenialMappingByRestaurantId.set(m.restaurantId, m.xenialStoreNumber);
      }
    }
    
    for (const location of locations) {
      const restaurant = await db.query.restaurants.findFirst({
        where: eq(restaurants.name, location.name),
      });
      
      if (!restaurant) {
        console.log(`Restaurant not found for location: ${location.name}`);
        continue;
      }
      
      const intervals = await api.getHourlySales(location.id, dateStr);
      
      if (intervals.length === 0) {
        console.log(`No intervals returned for ${location.name} on ${dateStr}`);
      }
      
      const locationTimezone = restaurant.timezone || 'America/Chicago';
      const timePunches = await api.getTimePunches(location.id, dateStr, locationTimezone);
      const roleMap = await api.getRoles(location.id);
      const scheduledShifts = await api.getScheduledShifts(location.id, dateStr);
      const operatorUserIds = await api.getOperatorUserIds(location.id);
      const laborByHour = api.getLaborHoursWithPositions(timePunches, dateStr, locationTimezone, roleMap);
      
      // Query POS sales from pos_orders table — POS is the sole source of sales data.
      // 7shifts sales data is redundant (same POS source with added delay).
      const posSalesByHour = new Map<number, number>();
      const xenialStoreNumber = xenialMappingByRestaurantId.get(restaurant.id);
      
      if (xenialStoreNumber) {
        const posStartOfDay = new Date(dateStr + 'T00:00:00.000Z');
        const posEndOfDay = new Date(dateStr + 'T23:59:59.999Z');
        const tzLiteral = sql.raw(`'${locationTimezone}'`);
        const posResults = await posDb
          .select({
            hour: sql<number>`extract(hour from ${posOrders.orderClosedAt} AT TIME ZONE ${tzLiteral})::int`,
            totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
          })
          .from(posOrders)
          .where(
            and(
              eq(posOrders.storeNumber, xenialStoreNumber),
              gte(posOrders.businessDate, posStartOfDay),
              lt(posOrders.businessDate, posEndOfDay)
            )
          )
          .groupBy(sql`extract(hour from ${posOrders.orderClosedAt} AT TIME ZONE ${tzLiteral})`);
        
        for (const row of posResults) {
          posSalesByHour.set(row.hour, Number(row.totalSales) || 0);
        }
      }
      
      if (intervals.length > 0) {
        const startOfDay = new Date(dateStr + 'T00:00:00.000Z');
        const endOfDay = new Date(dateStr + 'T23:59:59.999Z');
        
        await db.transaction(async (tx) => {
          await tx.delete(hourlySales)
            .where(and(
              eq(hourlySales.restaurantId, restaurant.id),
              gte(hourlySales.salesDate, startOfDay),
              lt(hourlySales.salesDate, endOfDay)
            ));
          
          for (const interval of intervals) {
            const hourMatch = interval.start.match(/T(\d{2}):/);
            const hour = hourMatch ? parseInt(hourMatch[1]) : 0;
            
            const hourLabor = laborByHour.get(hour) || { totalHours: 0, byPosition: {} };
            
            const roundedPositions: Record<string, number> = {};
            for (const [pos, hrs] of Object.entries(hourLabor.byPosition)) {
              roundedPositions[pos] = Math.round(hrs * 100) / 100;
            }
            
            const hasOperator = api.hasOperatorScheduledForHour(scheduledShifts, roleMap, hour, locationTimezone, dateStr, operatorUserIds);
            if (hasOperator) {
              roundedPositions['_operatorScheduled'] = 1;
            }
            
            const salesAmount = posSalesByHour.get(hour) || 0;
            
            await tx.insert(hourlySales).values({
              restaurantId: restaurant.id,
              salesDate: targetDate,
              hour,
              actualSales: salesAmount.toFixed(2),
              projectedSales: (interval.projected_sales / 100).toFixed(2),
              pastActualSales: '0.00',
            });
            
            const dateStr2 = targetDate.toISOString().split('T')[0];
            await tx.delete(hourlyLabor).where(
              and(
                eq(hourlyLabor.restaurantId, restaurant.id),
                eq(hourlyLabor.date, dateStr2),
                eq(hourlyLabor.hour, hour)
              )
            );
            // Round quarter values from time punch data
            const qb = hourLabor.quarters ? {
              q0: Math.round(hourLabor.quarters.q0 * 100) / 100,
              q1: Math.round(hourLabor.quarters.q1 * 100) / 100,
              q2: Math.round(hourLabor.quarters.q2 * 100) / 100,
              q3: Math.round(hourLabor.quarters.q3 * 100) / 100,
            } : undefined;

            await tx.insert(hourlyLabor).values({
              restaurantId: restaurant.id,
              date: dateStr2,
              hour,
              projectedLabor: (interval.projected_labor / 100).toFixed(2),
              actualLabor: (interval.actual_labor / 100).toFixed(2),
              employeeCount: (Math.round(hourLabor.totalHours * 100) / 100).toFixed(2),
              positionBreakdown: roundedPositions,
              quarterBreakdown: qb,
            });
            
            recordsScraped++;
          }
        });
        
        console.log(`Saved ${intervals.length} hourly records for ${location.name} (POS: ${posSalesByHour.size} hours, ${timePunches.length} time punches)`);
      }
    }
    
    console.log(`Hourly sync completed. ${recordsScraped} records saved.`);
    return { success: true, recordsScraped };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Hourly sync failed:', errorMessage);
    return { success: false, recordsScraped: 0, error: errorMessage };
  }
}

// Hybrid sync: Uses Xenial POS for sales data + 7shifts for labor data
// This removes the 24-hour constraint from 7shifts and provides real-time sales updates
export async function syncSalesWithXenialPOS(date?: Date): Promise<{ success: boolean; recordsScraped: number; error?: string }> {
  const accessToken = process.env.SEVENSHIFTS_API_TOKEN;
  
  if (!accessToken) {
    return {
      success: false,
      recordsScraped: 0,
      error: 'SEVENSHIFTS_API_TOKEN not configured',
    };
  }

  try {
    const api = new SevenShiftsAPI({ accessToken });
    await api.getCompany();
    
    const locations = await api.getLocations();
    
    // Determine target date in Central timezone
    let targetDate: Date;
    let dateStr: string;
    
    if (date) {
      // Normalize incoming date to noon UTC for consistent date matching
      dateStr = date.toISOString().split('T')[0];
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    } else {
      dateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: 'America/Chicago',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      targetDate = new Date(dateStr + 'T12:00:00.000Z');
    }
    
    // Get all restaurants with their location mappings
    const allRestaurants = await db.select().from(restaurants);
    const allMappings = await db.select().from(locationMapping);
    
    // Build mapping from restaurant ID to Xenial store numbers
    const restaurantToXenial = new Map<string, string>();
    const sevenShiftsToRestaurant = new Map<string, string>();
    for (const mapping of allMappings) {
      if (mapping.restaurantId && mapping.xenialStoreNumber) {
        restaurantToXenial.set(mapping.restaurantId, mapping.xenialStoreNumber);
      }
      if (mapping.restaurantId && mapping.sevenShiftsLocationId) {
        sevenShiftsToRestaurant.set(mapping.sevenShiftsLocationId, mapping.restaurantId);
      }
    }
    
    // Build map for restaurant lookups by ID
    const restaurantById = new Map(allRestaurants.map(r => [r.id, r]));
    
    console.log(`Xenial POS: ${restaurantToXenial.size} restaurants have Xenial mapping`);
    
    let recordsScraped = 0;
    
    for (const location of locations) {
      // Use location_mapping to find restaurant (prefer mapping over name match)
      let restaurant = sevenShiftsToRestaurant.has(String(location.id))
        ? restaurantById.get(sevenShiftsToRestaurant.get(String(location.id))!)
        : undefined;
      
      // Fallback to name matching if no mapping found
      if (!restaurant) {
        restaurant = allRestaurants.find(r => r.name === location.name);
      }
      
      if (!restaurant) {
        continue;
      }
      
      const locationTimezone = restaurant.timezone || 'America/Chicago';
      
      // Get the date string in restaurant's local timezone for proper POS data lookup
      const localDateStr = new Intl.DateTimeFormat('en-CA', { 
        timeZone: locationTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).format(new Date());
      
      // Use the same date for consistency (target date, not current date)
      const posDateStr = dateStr;
      
      // Get POS sales for this restaurant using timezone-aware hour extraction
      const xenialStoreNumber = restaurantToXenial.get(restaurant.id);
      const restaurantSales = new Map<number, number>();
      
      if (xenialStoreNumber) {
        // Fetch POS orders for this store with timezone-aware hour extraction
        const startOfDay = new Date(posDateStr + 'T00:00:00.000Z');
        const endOfDay = new Date(posDateStr + 'T23:59:59.999Z');
        
        // Extract hour in restaurant's local timezone using AT TIME ZONE
        // Use sql.raw for the timezone string since it's a known safe value from our database
        const tzLiteral = sql.raw(`'${locationTimezone}'`);
        const posResults = await posDb
          .select({
            hour: sql<number>`extract(hour from ${posOrders.orderClosedAt} AT TIME ZONE ${tzLiteral})::int`,
            totalSales: sql<number>`sum(${posOrders.orderTotal}::numeric)`,
          })
          .from(posOrders)
          .where(
            and(
              eq(posOrders.storeNumber, xenialStoreNumber),
              gte(posOrders.businessDate, startOfDay),
              lt(posOrders.businessDate, endOfDay)
            )
          )
          .groupBy(sql`extract(hour from ${posOrders.orderClosedAt} AT TIME ZONE ${tzLiteral})`);
        
        for (const row of posResults) {
          restaurantSales.set(row.hour, Number(row.totalSales) || 0);
        }
      }
      
      const hasPosData = restaurantSales.size > 0;
      
      // If no POS data, skip — no sales to write for this restaurant
      if (!hasPosData) {
        continue;
      }
      
      // Still need 7shifts for labor data (time punches, roles, operator schedules)
      const timePunches = await api.getTimePunches(location.id, dateStr, locationTimezone);
      const roleMap = await api.getRoles(location.id);
      const scheduledShifts = await api.getScheduledShifts(location.id, dateStr);
      const operatorUserIds = await api.getOperatorUserIds(location.id);

      // Get labor hours with position breakdown from 7shifts
      const laborByHour = api.getLaborHoursWithPositions(timePunches, dateStr, locationTimezone, roleMap);
      
      // Get projected labor/sales from 7shifts for forecasting only (not for actual sales)
      const intervals = await api.getHourlySales(location.id, dateStr);
      const projectedByHour = new Map<number, { projectedSales: number; projectedLabor: number; actualLabor: number }>();
      for (const interval of intervals) {
        const hourMatch = interval.start.match(/T(\d{2}):/);
        const hour = hourMatch ? parseInt(hourMatch[1]) : 0;
        projectedByHour.set(hour, {
          projectedSales: interval.projected_sales / 100,
          projectedLabor: interval.projected_labor / 100,
          actualLabor: interval.actual_labor / 100,
        });
      }
      
      // Determine which hours have data (POS sales or labor)
      const hoursWithData = new Set<number>();
      Array.from(restaurantSales.keys()).forEach(h => hoursWithData.add(h));
      Array.from(laborByHour.entries()).forEach(([h, labor]) => {
        if (labor.totalHours > 0) hoursWithData.add(h);
      });
      Array.from(projectedByHour.keys()).forEach(h => hoursWithData.add(h));
      
      if (hoursWithData.size > 0) {
        // Use UTC-based date range to match noon-normalized dates in database
        const dayStart = new Date(dateStr + 'T00:00:00.000Z');
        const dayEnd = new Date(dateStr + 'T23:59:59.999Z');
        
        await db.transaction(async (tx) => {
          // Delete existing hourly sales for this restaurant/date
          await tx.delete(hourlySales)
            .where(and(
              eq(hourlySales.restaurantId, restaurant.id),
              gte(hourlySales.salesDate, dayStart),
              lt(hourlySales.salesDate, dayEnd)
            ));
          
          // Insert new hourly records
          for (const hour of Array.from(hoursWithData).sort((a, b) => a - b)) {
            const hourLabor = laborByHour.get(hour) || { totalHours: 0, byPosition: {} };
            const projected = projectedByHour.get(hour) || { projectedSales: 0, projectedLabor: 0, actualLabor: 0 };
            
            const finalSales = restaurantSales.get(hour) || 0;
            
            // Round position hours
            const roundedPositions: Record<string, number> = {};
            for (const [pos, hrs] of Object.entries(hourLabor.byPosition)) {
              roundedPositions[pos] = Math.round(hrs * 100) / 100;
            }
            
            // Check if operator is scheduled
            const hasOperator = api.hasOperatorScheduledForHour(scheduledShifts, roleMap, hour, locationTimezone, dateStr, operatorUserIds);
            if (hasOperator) {
              roundedPositions['_operatorScheduled'] = 1;
            }
            
            // Insert sales data to hourlySales
            await tx.insert(hourlySales).values({
              restaurantId: restaurant.id,
              salesDate: targetDate,
              hour,
              actualSales: finalSales.toFixed(2),
              projectedSales: projected.projectedSales.toFixed(2),
              pastActualSales: '0.00',
            });
            
            // Insert labor data to separate hourlyLabor table
            const laborDateStr = targetDate.toISOString().split('T')[0];
            await tx.delete(hourlyLabor).where(
              and(
                eq(hourlyLabor.restaurantId, restaurant.id),
                eq(hourlyLabor.date, laborDateStr),
                eq(hourlyLabor.hour, hour)
              )
            );
            // Round quarter values from time punch data
            const quarterBreakdown = hourLabor.quarters ? {
              q0: Math.round(hourLabor.quarters.q0 * 100) / 100,
              q1: Math.round(hourLabor.quarters.q1 * 100) / 100,
              q2: Math.round(hourLabor.quarters.q2 * 100) / 100,
              q3: Math.round(hourLabor.quarters.q3 * 100) / 100,
            } : undefined;

            await tx.insert(hourlyLabor).values({
              restaurantId: restaurant.id,
              date: laborDateStr,
              hour,
              projectedLabor: projected.projectedLabor.toFixed(2),
              actualLabor: projected.actualLabor.toFixed(2),
              employeeCount: (Math.round(hourLabor.totalHours * 100) / 100).toFixed(2),
              positionBreakdown: roundedPositions,
              quarterBreakdown,
            });
            
            recordsScraped++;
          }
        });
        
        const posHours = restaurantSales.size;
        console.log(`Synced ${hoursWithData.size} hours for ${location.name} (${posHours > 0 ? posHours + ' POS' : '7shifts'} sales, ${timePunches.length} punches)`);
      }
    }
    
    console.log(`Xenial + 7shifts hybrid sync completed. ${recordsScraped} records saved.`);
    return { success: true, recordsScraped };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Hybrid sync failed:', errorMessage);
    return { success: false, recordsScraped: 0, error: errorMessage };
  }
}

// Import employees table for crew sync
import { employees, hourlyCrew } from '@shared/schema';

// Calculate tenure category based on hire date (with invitedAt as fallback)
export function getTenureCategory(
  hireDate: string | null, 
  asOfDate: Date = new Date(),
  invitedAt?: Date | null
): { category: 'trainee' | 'developing' | 'experienced' | 'veteran'; months: number } {
  // Use hireDate if available, otherwise fall back to invitedAt
  let startDate: Date | null = null;
  
  if (hireDate) {
    startDate = new Date(hireDate);
  } else if (invitedAt) {
    startDate = invitedAt;
  }
  
  if (!startDate) {
    // Default to trainee if no date available
    return { category: 'trainee', months: 0 };
  }
  
  const diffMs = asOfDate.getTime() - startDate.getTime();
  const months = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30.44)); // Average days per month
  
  if (months < 3) {
    return { category: 'trainee', months }; // < 90 days (Training)
  } else if (months < 6) {
    return { category: 'developing', months }; // 90 days - 6 months
  } else if (months < 12) {
    return { category: 'experienced', months }; // 6 months - 1 year
  } else {
    return { category: 'veteran', months }; // 1+ year
  }
}

// Calculate experience score (0-100) based on crew tenure mix
export function calculateExperienceScore(tenureMix: { trainee: number; developing: number; experienced: number; veteran: number }): number {
  const total = tenureMix.trainee + tenureMix.developing + tenureMix.experienced + tenureMix.veteran;
  if (total === 0) return 0;
  
  // Weights: Trainee=25, Developing=50, Experienced=75, Veteran=100
  const weightedSum = 
    tenureMix.trainee * 25 + 
    tenureMix.developing * 50 + 
    tenureMix.experienced * 75 + 
    tenureMix.veteran * 100;
  
  return Math.round(weightedSum / total);
}

// Format tenure as string like "1yr 3mo"
export function formatTenure(months: number): string {
  if (months < 1) return '<1mo';
  const years = Math.floor(months / 12);
  const remainingMonths = Math.round(months % 12);
  
  if (years === 0) return `${remainingMonths}mo`;
  if (remainingMonths === 0) return `${years}yr`;
  return `${years}yr ${remainingMonths}mo`;
}

// Format tenure mix as string like "2D 1V"
export function formatTenureMix(mix: { trainee: number; developing: number; experienced: number; veteran: number }): string {
  const parts: string[] = [];
  if (mix.trainee > 0) parts.push(`${mix.trainee}T`);
  if (mix.developing > 0) parts.push(`${mix.developing}D`);
  if (mix.experienced > 0) parts.push(`${mix.experienced}E`);
  if (mix.veteran > 0) parts.push(`${mix.veteran}V`);
  return parts.join(' ') || '-';
}

// Sync employees from 7shifts API
export async function syncEmployees(): Promise<{ success: boolean; count: number; withInvitedAt: number; error?: string }> {
  const token = process.env.SEVENSHIFTS_API_TOKEN;
  if (!token) {
    return { success: false, count: 0, withInvitedAt: 0, error: 'SEVENSHIFTS_API_TOKEN not configured' };
  }
  
  try {
    const api = new SevenShiftsAPI({ accessToken: token });
    await api.getCompany();
    
    // Get all locations to map to our restaurants
    const locations = await api.getLocations();
    const allRestaurants = await db.select().from(restaurants);
    
    // Create location ID to restaurant ID mapping
    const locationToRestaurant = new Map<number, string>();
    for (const loc of locations) {
      // Match by name (7shifts location name contains restaurant name)
      const matchingRestaurant = allRestaurants.find(r => 
        loc.name.includes(r.name) || r.name.includes(loc.name)
      );
      if (matchingRestaurant) {
        locationToRestaurant.set(loc.id, matchingRestaurant.id);
      }
    }
    
    // Fetch all users from 7shifts
    const users = await api.getUsers();
    console.log(`[EmployeeSync] Processing ${users.length} users from 7shifts`);
    
    let syncedCount = 0;
    let withInvitedAtCount = 0;
    
    for (const user of users) {
      try {
        // Parse invited date if available (fallback for hire_date)
        const invitedAt = user.invited ? new Date(user.invited) : null;
        if (invitedAt) withInvitedAtCount++;
        
        // Upsert employee record
        await db.insert(employees).values({
          sevenShiftsUserId: user.id,
          firstName: user.first_name,
          lastName: user.last_name,
          hireDate: user.hire_date || null,
          invitedAt: invitedAt,
          active: user.active,
          type: user.type,
          // Note: We'd need to fetch user assignments to get their primary location
        }).onConflictDoUpdate({
          target: employees.sevenShiftsUserId,
          set: {
            firstName: user.first_name,
            lastName: user.last_name,
            hireDate: user.hire_date || null,
            invitedAt: invitedAt,
            active: user.active,
            type: user.type,
            syncedAt: new Date(),
          },
        });
        
        syncedCount++;
      } catch (err) {
        console.error(`[EmployeeSync] Error syncing user ${user.id}:`, err);
      }
    }
    
    console.log(`[EmployeeSync] Synced ${syncedCount} employees (${withInvitedAtCount} with invited_at dates)`);
    return { success: true, count: syncedCount, withInvitedAt: withInvitedAtCount };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[EmployeeSync] Failed:', msg);
    return { success: false, count: 0, withInvitedAt: 0, error: msg };
  }
}

// Sync hourly crew data from time punches
export async function syncHourlyCrew(date?: Date): Promise<{ success: boolean; count: number; error?: string }> {
  const token = process.env.SEVENSHIFTS_API_TOKEN;
  if (!token) {
    return { success: false, count: 0, error: 'SEVENSHIFTS_API_TOKEN not configured' };
  }
  
  const targetDate = date || new Date();
  const dateStr = targetDate.toISOString().split('T')[0];
  
  try {
    const api = new SevenShiftsAPI({ accessToken: token });
    await api.getCompany();
    
    const locations = await api.getLocations();
    const allRestaurants = await db.select().from(restaurants);
    
    // Load all employees for lookup
    const allEmployees = await db.select().from(employees);
    const employeeMap = new Map(allEmployees.map(e => [e.sevenShiftsUserId, e]));
    
    let syncedCount = 0;
    
    for (const location of locations) {
      const restaurant = allRestaurants.find(r => 
        location.name.includes(r.name) || r.name.includes(location.name)
      );
      
      if (!restaurant) continue;
      
      const timezone = restaurant.timezone || 'America/Chicago';
      
      // Fetch time punches for the day with timezone-aware date range
      const timePunches = await api.getTimePunches(location.id, dateStr, timezone);
      
      if (timePunches.length === 0) {
        console.log(`[CrewSync] No time punches for ${location.name} on ${dateStr}`);
        continue;
      }
      
      // Fetch roles to update employee positions
      const roleMap = await api.getRoles(location.id);
      
      // Update employee positions from time punches
      for (const punch of timePunches) {
        const positionName = roleMap.get(punch.role_id);
        if (positionName) {
          await db.update(employees)
            .set({ 
              position: positionName,
              locationId: location.id,
              restaurantId: restaurant.id,
            })
            .where(eq(employees.sevenShiftsUserId, punch.user_id));
        }
      }
      
      // Process each hour
      for (let hour = 0; hour < 24; hour++) {
        const usersWithPositions = api.getUsersWithPositionsWorkingHour(timePunches, roleMap, hour, dateStr, timezone);
        
        if (usersWithPositions.length === 0) continue;
        
        // Build crew data for this hour (now includes position from time punch)
        const crewMembers: { userId: number; firstName: string; lastName: string; tenureMonths: number; category: string; position: string }[] = [];
        const tenureMix = { trainee: 0, developing: 0, experienced: 0, veteran: 0 };
        let totalMonths = 0;
        
        for (const { userId, position } of usersWithPositions) {
          const emp = employeeMap.get(userId);
          if (!emp) continue;
          
          // Pass invitedAt as fallback for hireDate
          const tenure = getTenureCategory(emp.hireDate, targetDate, emp.invitedAt);
          crewMembers.push({
            userId,
            firstName: emp.firstName,
            lastName: emp.lastName,
            tenureMonths: tenure.months,
            category: tenure.category,
            position, // Position they are working THIS hour (from time punch role_id)
          });
          
          tenureMix[tenure.category]++;
          totalMonths += tenure.months;
        }
        
        if (crewMembers.length === 0) continue;
        
        const avgTenureMonths = totalMonths / crewMembers.length;
        const score = calculateExperienceScore(tenureMix);
        
        // Upsert hourly crew record
        await db.insert(hourlyCrew).values({
          restaurantId: restaurant.id,
          date: dateStr,
          hour,
          crewCount: crewMembers.length,
          avgTenureMonths: avgTenureMonths.toFixed(1),
          experienceScore: score,
          tenureMix,
          crewMembers,
        }).onConflictDoUpdate({
          target: [hourlyCrew.restaurantId, hourlyCrew.date, hourlyCrew.hour],
          set: {
            crewCount: crewMembers.length,
            avgTenureMonths: avgTenureMonths.toFixed(1),
            experienceScore: score,
            tenureMix,
            crewMembers,
            syncedAt: new Date(),
          },
        });
        
        syncedCount++;
      }
      
      console.log(`[CrewSync] Synced crew data for ${location.name} on ${dateStr}`);
    }
    
    console.log(`[CrewSync] Completed. ${syncedCount} hourly records synced.`);
    return { success: true, count: syncedCount };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[CrewSync] Failed:', msg);
    return { success: false, count: 0, error: msg };
  }
}

// Debug function to resync labor data for a specific restaurant and date
export async function resyncLaborForRestaurant(
  restaurantName: string, 
  dateStr: string
): Promise<{ success: boolean; message: string; rawPunches: any[]; hourlyData: any }> {
  try {
    console.log(`[Labor Resync] Starting resync for ${restaurantName} on ${dateStr}`);
    
    const token = process.env.SEVENSHIFTS_API_TOKEN;
    if (!token) {
      return { success: false, message: "SEVENSHIFTS_API_TOKEN not configured", rawPunches: [], hourlyData: null };
    }
    
    const api = new SevenShiftsAPI({ accessToken: token });
    await api.getCompany();
    
    // Find the restaurant in our database
    const restaurant = await db.select().from(restaurants)
      .where(sql`${restaurants.name} ILIKE ${`%${restaurantName}%`}`)
      .limit(1);
    
    if (restaurant.length === 0) {
      return { success: false, message: `Restaurant not found: ${restaurantName}`, rawPunches: [], hourlyData: null };
    }
    
    const rest = restaurant[0];
    console.log(`[Labor Resync] Found restaurant: ${rest.name} (ID: ${rest.id})`);
    
    // Get locations from 7shifts to find the location ID
    const locations = await api.getLocations();
    
    const location = locations.find((loc: any) => 
      loc.name.toLowerCase().includes(restaurantName.toLowerCase()) ||
      restaurantName.toLowerCase().includes(loc.name.split(' - ')[0]?.toLowerCase())
    );
    
    if (!location) {
      return { success: false, message: `Location not found in 7shifts: ${restaurantName}`, rawPunches: [], hourlyData: null };
    }
    
    console.log(`[Labor Resync] Found 7shifts location: ${location.name} (ID: ${location.id}, TZ: ${location.timezone})`);
    
    // Calculate date range for time punches
    const locationTimezone = location.timezone || "America/Chicago";
    
    // Parse the date string and create start/end timestamps
    const [year, month, day] = dateStr.split('-').map(Number);
    
    // Get UTC offset for the location timezone
    const testDate = new Date(`${dateStr}T12:00:00`);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: locationTimezone,
      hour: 'numeric',
      hourCycle: 'h23',
    });
    
    // Use a fixed offset approach for timezone handling
    const isEastern = locationTimezone.includes('New_York');
    const utcOffset = isEastern ? 5 : 6; // EST is UTC-5, CST is UTC-6 (simplified)
    
    // Start of day in local timezone, converted to UTC
    const startOfDayLocal = new Date(Date.UTC(year, month - 1, day, utcOffset, 0, 0));
    const endOfDayLocal = new Date(Date.UTC(year, month - 1, day + 1, utcOffset - 1, 59, 59));
    
    // Expand the window to capture overnight shifts
    const punchStart = new Date(startOfDayLocal.getTime() - 4 * 60 * 60 * 1000); // 4 hours before
    const punchEnd = new Date(endOfDayLocal.getTime() + 4 * 60 * 60 * 1000); // 4 hours after
    
    console.log(`[Labor Resync] Time punch window: ${punchStart.toISOString()} to ${punchEnd.toISOString()}`);
    console.log(`[Labor Resync] Business day (local): ${startOfDayLocal.toISOString()} to ${endOfDayLocal.toISOString()}`);
    
    // Fetch time punches from 7shifts using the API class with timezone-aware date range
    const timePunches = await api.getTimePunches(location.id, dateStr, locationTimezone);
    console.log(`[Labor Resync] Found ${timePunches.length} time punches from 7shifts`);
    
    // Analyze punches by hour
    const hourlyBreakdown: Record<number, { count: number; names: string[] }> = {};
    for (let h = 0; h < 24; h++) {
      hourlyBreakdown[h] = { count: 0, names: [] };
    }
    
    const punchDetails: any[] = [];
    
    for (const punch of timePunches) {
      const clockIn = new Date(punch.clocked_in);
      const clockOut = punch.clocked_out ? new Date(punch.clocked_out) : null;
      
      // Convert to local time for display
      const clockInLocal = clockIn.toLocaleString('en-US', { timeZone: locationTimezone });
      const clockOutLocal = clockOut ? clockOut.toLocaleString('en-US', { timeZone: locationTimezone }) : 'Still clocked in';
      
      punchDetails.push({
        userId: punch.user_id,
        firstName: punch.first_name,
        lastName: punch.last_name,
        role: punch.role?.name || 'Unknown',
        clockInUTC: punch.clocked_in,
        clockOutUTC: punch.clocked_out,
        clockInLocal,
        clockOutLocal,
      });
      
      // Calculate which hours this punch covers
      for (let h = 0; h < 24; h++) {
        const hourStartUTC = new Date(Date.UTC(year, month - 1, day, utcOffset + h, 0, 0));
        const hourEndUTC = new Date(Date.UTC(year, month - 1, day, utcOffset + h + 1, 0, 0));
        
        const effectiveClockOut = clockOut || new Date(); // Use current time if still working
        
        // Check if this punch overlaps with this hour
        if (clockIn < hourEndUTC && effectiveClockOut > hourStartUTC) {
          hourlyBreakdown[h].count++;
          hourlyBreakdown[h].names.push(punch.first_name || 'Unknown');
        }
      }
    }
    
    // Log detailed breakdown
    console.log(`[Labor Resync] Hourly breakdown for ${rest.name} on ${dateStr}:`);
    for (let h = 5; h <= 23; h++) { // 5am to 11pm local
      const data = hourlyBreakdown[h];
      if (data.count > 0 || h >= 12) { // Always show afternoon hours
        console.log(`  Hour ${h}:00 - ${data.count} employees: ${data.names.join(', ')}`);
      }
    }
    
    // Compare with what's in our database
    const existingData = await db.select()
      .from(hourlyLabor)
      .where(and(
        eq(hourlyLabor.restaurantId, rest.id),
        sql`${hourlyLabor.date}::date = ${dateStr}`
      ))
      .orderBy(hourlyLabor.hour);
    
    console.log(`[Labor Resync] Existing database records: ${existingData.length}`);
    
    // Normalize date for storage (as ISO string with noon UTC)
    const normalizedDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString();
    
    // Delete existing records and insert new ones with correct employee counts
    await db.execute(sql`
      DELETE FROM hourly_labor 
      WHERE restaurant_id = ${rest.id} 
      AND date::date = ${dateStr}::date
    `);
    console.log(`[Labor Resync] Cleared existing records for ${rest.name} on ${dateStr}`);
    
    // Insert hourly_labor records with correct employee counts from time punches
    let updatedHours = 0;
    for (let h = 0; h < 24; h++) {
      const data = hourlyBreakdown[h];
      if (data.count > 0) {
        await db
          .insert(hourlyLabor)
          .values({
            restaurantId: rest.id,
            date: normalizedDate,
            hour: h,
            actualLabor: data.count, // Use actual employee count
            employeeCount: String(data.count),
            positionBreakdown: {}, // Would need role mapping for position breakdown
          });
        updatedHours++;
      }
    }
    console.log(`[Labor Resync] Updated ${updatedHours} hours with correct employee counts`);
    
    return {
      success: true,
      message: `Fixed ${updatedHours} hours with ${timePunches.length} punches from 7shifts`,
      rawPunches: punchDetails.slice(0, 50), // Limit to first 50 for response size
      hourlyData: {
        breakdown: hourlyBreakdown,
        existingDbRecords: existingData.map(r => ({
          hour: r.hour,
          employeeCount: r.employeeCount,
        })),
        location: {
          id: location.id,
          name: location.name,
          timezone: location.timezone,
        }
      }
    };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Labor Resync] Error:', msg);
    return { success: false, message: msg, rawPunches: [], hourlyData: null };
  }
}

// Fix labor data for a restaurant on a specific date by resyncing from 7shifts
// This actually updates the hourly_labor table with correct timezone-aware data
export async function fixLaborForRestaurant(restaurantName: string, dateStr: string) {
  try {
    console.log(`[Labor Fix] Starting fix for ${restaurantName} on ${dateStr}`);
    
    const token = process.env.SEVENSHIFTS_API_TOKEN;
    if (!token) {
      return { success: false, message: 'SEVENSHIFTS_API_TOKEN not configured' };
    }
    
    // Find the restaurant
    const rest = await db.query.restaurants.findFirst({
      where: (r, { ilike }) => ilike(r.name, `%${restaurantName}%`),
    });
    
    if (!rest) {
      return { success: false, message: `Restaurant not found: ${restaurantName}` };
    }
    
    const locationTimezone = rest.timezone || 'America/Chicago';
    console.log(`[Labor Fix] Found restaurant: ${rest.name} (timezone: ${locationTimezone})`);
    
    // Initialize 7shifts API with token
    const api = new SevenShiftsAPI({ accessToken: token });
    await api.getCompany();
    const locations = await api.getLocations();
    
    const location = locations.find(l => 
      l.name.includes(rest.name) || rest.name.includes(l.name) ||
      l.name.includes(restaurantName) || restaurantName.split(' ').some(w => l.name.includes(w))
    );
    
    if (!location) {
      return { success: false, message: `7shifts location not found for ${restaurantName}` };
    }
    
    console.log(`[Labor Fix] Found 7shifts location: ${location.name} (ID: ${location.id})`);
    
    // Fetch time punches with timezone-aware date range
    const timePunches = await api.getTimePunches(location.id, dateStr, locationTimezone);
    console.log(`[Labor Fix] Found ${timePunches.length} time punches`);
    
    if (timePunches.length === 0) {
      return { success: false, message: 'No time punches found for this date' };
    }
    
    // Fetch roles to map role_id to position names
    const roleMap = await api.getRoles(location.id);
    
    // Get labor hours WITH position breakdown
    const laborByHour = api.getLaborHoursWithPositions(timePunches, dateStr, locationTimezone, roleMap);
    console.log(`[Labor Fix] Calculated labor for ${laborByHour.size} hours`);
    
    // Also fetch scheduled shifts for operators
    const scheduledShifts = await api.getScheduledShifts(location.id, dateStr);
    
    // Normalize date for storage (as ISO string with noon UTC)
    const [year, month, day] = dateStr.split('-').map(Number);
    const normalizedDate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).toISOString();
    
    // Delete ALL existing records for this restaurant/date to handle date format mismatches
    // (old records may have different timestamp formats that don't match the upsert conflict key)
    // Use raw SQL since the date column is text but stores dates
    await db.execute(sql`
      DELETE FROM hourly_labor 
      WHERE restaurant_id = ${rest.id} 
      AND date::date = ${dateStr}::date
    `);
    console.log(`[Labor Fix] Cleared existing records for ${rest.name} on ${dateStr}`);
    
    // Insert hourly_labor records
    let updatedHours = 0;
    for (const [hour, laborData] of laborByHour.entries()) {
      // laborData has { totalHours, byPosition, quarters } - use byPosition for position breakdown
      const positionBreakdown = { ...laborData.byPosition };

      // Calculate employee count from total hours worked (approximate)
      // For a full hour, totalHours equals the number of people working
      const employeeCount = laborData.totalHours;

      // Round quarter values
      const quarterBreakdown = {
        q0: Math.round(laborData.quarters.q0 * 100) / 100,
        q1: Math.round(laborData.quarters.q1 * 100) / 100,
        q2: Math.round(laborData.quarters.q2 * 100) / 100,
        q3: Math.round(laborData.quarters.q3 * 100) / 100,
      };

      // Upsert the hourly_labor record
      await db
        .insert(hourlyLabor)
        .values({
          restaurantId: rest.id,
          date: normalizedDate,
          hour,
          actualLabor: laborData.totalHours,
          employeeCount: String(employeeCount),
          positionBreakdown,
          quarterBreakdown,
        })
        .onConflictDoUpdate({
          target: [hourlyLabor.restaurantId, hourlyLabor.date, hourlyLabor.hour],
          set: {
            actualLabor: laborData.totalHours,
            employeeCount: String(employeeCount),
            positionBreakdown,
            quarterBreakdown,
          },
        });
      
      updatedHours++;
    }
    
    console.log(`[Labor Fix] Updated ${updatedHours} hourly records for ${rest.name}`);
    
    return {
      success: true,
      message: `Fixed labor data: ${updatedHours} hours updated with ${timePunches.length} time punches`,
      restaurantId: rest.id,
      date: dateStr,
      hoursUpdated: updatedHours,
      punchCount: timePunches.length,
      sampleHours: Object.fromEntries(
        Array.from(laborByHour.entries())
          .filter(([h]) => h >= 10 && h <= 20)
          .map(([h, data]) => [h, { employeeCount: data.employeeCount, totalHours: data.totalHours }])
      ),
    };
    
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error('[Labor Fix] Error:', msg);
    return { success: false, message: msg };
  }
}
