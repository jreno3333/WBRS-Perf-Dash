import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Settings, CalendarIcon, Save, Home, X, Car, Smartphone, Utensils, ShoppingBag, Timer, RefreshCw, CheckCircle, AlertCircle, Receipt, Clock, Database } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { format, differenceInDays, isFuture, parseISO } from "date-fns";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Restaurant } from "@shared/schema";

const REVENUE_PORTS = [
  { id: "dine_in", label: "Dine In", icon: Utensils, color: "bg-emerald-500" },
  { id: "drive_thru", label: "Drive Thru", icon: Car, color: "bg-amber-500" },
  { id: "app", label: "APP", icon: Smartphone, color: "bg-blue-500" },
  { id: "3pd", label: "3PD", icon: ShoppingBag, color: "bg-purple-500" },
] as const;

type RestaurantWithStatus = Restaurant & {
  status: "training" | "new" | "established";
  daysOpen?: number;
};

// Parse date string as local date to avoid timezone issues
function parseLocalDate(dateStr: string | null | undefined): Date | null {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function getRestaurantStatus(openDateStr: string | null | undefined): { status: "training" | "new" | "established"; daysOpen?: number } {
  if (!openDateStr) return { status: "established" };
  
  const openDate = parseLocalDate(openDateStr);
  if (!openDate) return { status: "established" };
  
  const today = new Date();
  today.setHours(0, 0, 0, 0); // Normalize to start of day for comparison
  
  if (openDate > today) {
    return { status: "training" };
  }
  
  const daysOpen = differenceInDays(today, openDate);
  if (daysOpen < 90) {
    return { status: "new", daysOpen };
  }
  
  return { status: "established", daysOpen };
}

export default function SettingsPage() {
  const { toast } = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<Date | undefined>();

  const { data: restaurants, isLoading } = useQuery<Restaurant[]>({
    queryKey: ["/api/restaurants"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, openDate }: { id: string; openDate: string | null }) => {
      console.log('[Settings] Sending PATCH:', { id, openDate });
      return apiRequest("PATCH", `/api/restaurants/${id}`, { openDate });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      setEditingId(null);
      setEditDate(undefined);
      toast({
        title: "Restaurant updated",
        description: "Open date has been saved successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update restaurant.",
        variant: "destructive",
      });
    },
  });

  const revenuePortMutation = useMutation({
    mutationFn: async ({ id, revenuePorts }: { id: string; revenuePorts: string[] }) => {
      return apiRequest("PATCH", `/api/restaurants/${id}`, { revenuePorts });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
      toast({
        title: "Revenue ports updated",
        description: "Changes saved successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update revenue ports.",
        variant: "destructive",
      });
    },
  });

  const handleSave = (id: string) => {
    console.log('[Settings] handleSave called:', { id, editDate, formatted: editDate ? format(editDate, "yyyy-MM-dd") : null });
    updateMutation.mutate({
      id,
      openDate: editDate ? format(editDate, "yyyy-MM-dd") : null,
    });
  };

  const handleClear = (id: string) => {
    updateMutation.mutate({
      id,
      openDate: null,
    });
  };

  const toggleRevenuePort = (restaurantId: string, currentPorts: string[] | null, portId: string) => {
    const ports = currentPorts || [];
    const newPorts = ports.includes(portId)
      ? ports.filter(p => p !== portId)
      : [...ports, portId];
    revenuePortMutation.mutate({ id: restaurantId, revenuePorts: newPorts });
  };

  const startEditing = (restaurant: Restaurant) => {
    setEditingId(restaurant.id);
    // Parse date string as local date (not UTC) to avoid off-by-one day issues
    // "2026-01-24" should be January 24th in local time, not UTC midnight
    if (restaurant.openDate) {
      const [year, month, day] = restaurant.openDate.split('-').map(Number);
      setEditDate(new Date(year, month - 1, day)); // month is 0-indexed
    } else {
      setEditDate(undefined);
    }
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditDate(undefined);
  };

  const restaurantsWithStatus: RestaurantWithStatus[] = (restaurants || []).map(r => ({
    ...r,
    ...getRestaurantStatus(r.openDate),
  }));

  const trainingUnits = restaurantsWithStatus.filter(r => r.status === "training");
  const newUnits = restaurantsWithStatus.filter(r => r.status === "new");
  const establishedUnits = restaurantsWithStatus.filter(r => r.status === "established");

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Settings className="h-6 w-6 text-primary" />
              <h1 className="text-2xl font-bold">Settings</h1>
            </div>
            <div className="flex items-center gap-2">
              <Link href="/">
                <Button variant="outline" size="sm" data-testid="link-dashboard">
                  <Home className="h-4 w-4 mr-2" />
                  Dashboard
                </Button>
              </Link>
              <ThemeToggle />
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Restaurant Open Dates</CardTitle>
              <CardDescription>
                Set open dates for each restaurant. Units with future dates are in training mode (excluded from rankings).
                Units less than 90 days old show a "NEW UNIT" badge.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6">
                {trainingUnits.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Badge variant="secondary">Training</Badge>
                      <span className="text-muted-foreground text-sm font-normal">
                        ({trainingUnits.length} units - excluded from rankings)
                      </span>
                    </h3>
                    <div className="grid gap-3">
                      {trainingUnits.map(restaurant => (
                        <RestaurantRow
                          key={restaurant.id}
                          restaurant={restaurant}
                          isEditing={editingId === restaurant.id}
                          editDate={editingId === restaurant.id ? editDate : undefined}
                          setEditDate={setEditDate}
                          onStartEditing={() => startEditing(restaurant)}
                          onSave={() => handleSave(restaurant.id)}
                          onClear={() => handleClear(restaurant.id)}
                          onCancel={cancelEditing}
                          isPending={updateMutation.isPending}
                          onToggleRevenuePort={(portId) => toggleRevenuePort(restaurant.id, restaurant.revenuePorts, portId)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {newUnits.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      <Badge className="bg-blue-500 hover:bg-blue-600">NEW UNIT</Badge>
                      <span className="text-muted-foreground text-sm font-normal">
                        ({newUnits.length} units - less than 90 days old)
                      </span>
                    </h3>
                    <div className="grid gap-3">
                      {newUnits.map(restaurant => (
                        <RestaurantRow
                          key={restaurant.id}
                          restaurant={restaurant}
                          isEditing={editingId === restaurant.id}
                          editDate={editingId === restaurant.id ? editDate : undefined}
                          setEditDate={setEditDate}
                          onStartEditing={() => startEditing(restaurant)}
                          onSave={() => handleSave(restaurant.id)}
                          onClear={() => handleClear(restaurant.id)}
                          onCancel={cancelEditing}
                          isPending={updateMutation.isPending}
                          onToggleRevenuePort={(portId) => toggleRevenuePort(restaurant.id, restaurant.revenuePorts, portId)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {establishedUnits.length > 0 && (
                  <div>
                    <h3 className="text-lg font-semibold mb-3 flex items-center gap-2">
                      Established Units
                      <span className="text-muted-foreground text-sm font-normal">
                        ({establishedUnits.length} units)
                      </span>
                    </h3>
                    <div className="grid gap-3">
                      {establishedUnits.map(restaurant => (
                        <RestaurantRow
                          key={restaurant.id}
                          restaurant={restaurant}
                          isEditing={editingId === restaurant.id}
                          editDate={editingId === restaurant.id ? editDate : undefined}
                          setEditDate={setEditDate}
                          onStartEditing={() => startEditing(restaurant)}
                          onSave={() => handleSave(restaurant.id)}
                          onClear={() => handleClear(restaurant.id)}
                          onCancel={cancelEditing}
                          isPending={updateMutation.isPending}
                          onToggleRevenuePort={(portId) => toggleRevenuePort(restaurant.id, restaurant.revenuePorts, portId)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {isLoading && (
                  <div className="text-center py-8 text-muted-foreground">
                    Loading restaurants...
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Status Definitions</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="flex items-start gap-3">
                <Badge variant="secondary" className="mt-0.5">Training</Badge>
                <div>
                  <p className="font-medium">Training Units</p>
                  <p className="text-sm text-muted-foreground">
                    Open date is in the future. These units are excluded from leaderboard rankings but still displayed on the dashboard.
                    Sales during this period are considered training sales.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Badge className="bg-blue-500 hover:bg-blue-600 mt-0.5">NEW UNIT</Badge>
                <div>
                  <p className="font-medium">New Units</p>
                  <p className="text-sm text-muted-foreground">
                    Open date is within the last 90 days. These units are included in rankings with a "NEW UNIT" badge.
                    The badge is automatically removed after 90 days.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <div className="w-[70px]"></div>
                <div>
                  <p className="font-medium">Established Units</p>
                  <p className="text-sm text-muted-foreground">
                    Open date is more than 90 days ago (or not set). These units are fully included in all rankings and comparisons.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <XenialSyncCard />

          <HMESyncCard />
        </div>
      </main>
    </div>
  );
}

function RestaurantRow({
  restaurant,
  isEditing,
  editDate,
  setEditDate,
  onStartEditing,
  onSave,
  onClear,
  onCancel,
  isPending,
  onToggleRevenuePort,
}: {
  restaurant: RestaurantWithStatus;
  isEditing: boolean;
  editDate: Date | undefined;
  setEditDate: (date: Date | undefined) => void;
  onStartEditing: () => void;
  onSave: () => void;
  onClear: () => void;
  onCancel: () => void;
  isPending: boolean;
  onToggleRevenuePort: (portId: string) => void;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const openDate = parseLocalDate(restaurant.openDate);
  const revenuePorts = restaurant.revenuePorts || [];

  return (
    <div
      className="flex flex-col gap-3 p-3 rounded-lg border bg-card hover-elevate"
      data-testid={`row-restaurant-${restaurant.id}`}
    >
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          <span className="font-medium truncate">{restaurant.name}</span>
          {restaurant.status === "training" && (
            <Badge variant="secondary" className="shrink-0">Training</Badge>
          )}
          {restaurant.status === "new" && (
            <Badge className="bg-blue-500 hover:bg-blue-600 shrink-0">
              NEW UNIT ({restaurant.daysOpen && restaurant.daysOpen >= 7 ? `${Math.floor(restaurant.daysOpen / 7)}w ${restaurant.daysOpen % 7}d` : `${restaurant.daysOpen || 0}d`})
            </Badge>
          )}
        </div>

      <div className="flex items-center gap-2 flex-wrap">
        {isEditing ? (
          <>
            <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-[180px] justify-start text-left font-normal"
                  data-testid={`button-date-picker-${restaurant.id}`}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {editDate ? format(editDate, "MMM d, yyyy") : "Select date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={editDate}
                  onSelect={(date) => {
                    console.log('[Settings] Calendar onSelect called:', date);
                    setEditDate(date);
                    setCalendarOpen(false);
                  }}
                  initialFocus
                  defaultMonth={editDate}
                />
              </PopoverContent>
            </Popover>
            <Button
              size="sm"
              onClick={onSave}
              disabled={isPending}
              data-testid={`button-save-${restaurant.id}`}
            >
              <Save className="h-4 w-4 mr-1" />
              Save
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onCancel}
              disabled={isPending}
              data-testid={`button-cancel-${restaurant.id}`}
            >
              <X className="h-4 w-4" />
            </Button>
          </>
        ) : (
          <>
            <span className="text-sm text-muted-foreground">
              {openDate ? format(openDate, "MMM d, yyyy") : "No open date set"}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={onStartEditing}
              data-testid={`button-edit-${restaurant.id}`}
            >
              Edit
            </Button>
            {openDate && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onClear}
                disabled={isPending}
                data-testid={`button-clear-${restaurant.id}`}
              >
                Clear
              </Button>
            )}
          </>
        )}
      </div>
      </div>
      
      {/* Revenue Ports */}
      <div className="flex items-center gap-4 pt-2 border-t border-border/50">
        <span className="text-xs text-muted-foreground shrink-0">Revenue Ports:</span>
        <div className="flex items-center gap-3 flex-wrap">
          {REVENUE_PORTS.map(port => {
            const Icon = port.icon;
            const isActive = revenuePorts.includes(port.id);
            return (
              <div 
                key={port.id} 
                className="flex items-center gap-1.5"
              >
                <Checkbox
                  id={`${restaurant.id}-${port.id}`}
                  checked={isActive}
                  onCheckedChange={() => onToggleRevenuePort(port.id)}
                  data-testid={`checkbox-${port.id}-${restaurant.id}`}
                />
                <label 
                  htmlFor={`${restaurant.id}-${port.id}`}
                  className="flex items-center gap-1 text-xs cursor-pointer"
                >
                  <Icon className="h-3 w-3" />
                  <span>{port.label}</span>
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface XenialStatus {
  status?: string;
  webhookEndpoint?: string;
  webhookEnabled: boolean;
  serverTime?: string;
  // New nested format
  today?: {
    date?: string;
    orderCount: number;
    salesTotal: number;
  };
  lastHour?: {
    orderCount: number;
    salesTotal: number;
  };
  allTime?: {
    orderCount: number;
    salesTotal: number;
  };
  // Old flat format (backwards compatibility)
  todayOrderCount?: number;
  todaySalesTotal?: number;
  // Common fields
  lastOrderReceived: string | null;
  lastOrderStore: string | null;
  lastOrderAmount?: number | null;
  storeBreakdown?: Array<{ store: string; orders: number; total: number }>;
  recentOrders?: Array<{ store: string; amount: number; source: string; receivedAt: string }>;
}

function XenialSyncCard() {
  const { data: xenialStatus, isLoading: statusLoading, refetch: refetchStatus } = useQuery<XenialStatus>({
    queryKey: ["/api/pos/status"],
    refetchInterval: 30000,
  });

  const formatTime = (isoString: string | null) => {
    if (!isoString) return "Never";
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} minute${diffMins !== 1 ? "s" : ""} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? "s" : ""} ago`;
    return `${diffDays} day${diffDays !== 1 ? "s" : ""} ago`;
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amount);
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Receipt className="h-5 w-5 text-primary" />
          <CardTitle>Xenial POS Orders</CardTitle>
        </div>
        <CardDescription>
          Live order data from Xenial POS systems. Data is synced from the shared production database.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {statusLoading ? (
          <div className="text-muted-foreground text-sm">Loading POS status...</div>
        ) : xenialStatus ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Data Source:</span>
              <Badge className="bg-blue-500 hover:bg-blue-600">
                <Database className="h-3 w-3 mr-1" />
                Shared Database
              </Badge>
            </div>
            
            <div className="grid grid-cols-2 gap-4 pt-2">
              <div className="bg-muted/50 rounded-lg p-3">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Today</div>
                <div className="text-2xl font-bold">
                  {(xenialStatus.today?.orderCount ?? xenialStatus.todayOrderCount ?? 0).toLocaleString()}
                </div>
                <div className="text-sm text-muted-foreground">
                  orders ({formatCurrency(xenialStatus.today?.salesTotal ?? xenialStatus.todaySalesTotal ?? 0)})
                </div>
              </div>
              <div className="bg-muted/50 rounded-lg p-3">
                <div className="text-xs text-muted-foreground uppercase tracking-wide">Last Hour</div>
                <div className="text-2xl font-bold">
                  {(xenialStatus.lastHour?.orderCount ?? 0).toLocaleString()}
                </div>
                <div className="text-sm text-muted-foreground">
                  orders ({formatCurrency(xenialStatus.lastHour?.salesTotal ?? 0)})
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap pt-2">
              <Clock className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Last Order:</span>
              <span className="text-sm text-muted-foreground">
                {xenialStatus.lastOrderReceived ? (
                  <>
                    Store {xenialStatus.lastOrderStore} - {formatCurrency(xenialStatus.lastOrderAmount || 0)} ({formatTime(xenialStatus.lastOrderReceived)})
                  </>
                ) : (
                  "No orders received yet"
                )}
              </span>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">All Time:</span>
              <span className="text-sm text-muted-foreground">
                {(xenialStatus.allTime?.orderCount ?? xenialStatus.todayOrderCount ?? 0).toLocaleString()} orders ({formatCurrency(xenialStatus.allTime?.salesTotal ?? xenialStatus.todaySalesTotal ?? 0)})
              </span>
            </div>

            {xenialStatus.storeBreakdown && xenialStatus.storeBreakdown.length > 0 && (
              <div className="pt-2 border-t">
                <span className="text-sm font-medium">Today's Orders by Store:</span>
                <div className="flex flex-wrap gap-2 mt-2">
                  {xenialStatus.storeBreakdown.slice(0, 6).map((store) => (
                    <Badge key={store.store} variant="outline" className="text-xs">
                      {store.store}: {store.orders} ({formatCurrency(store.total)})
                    </Badge>
                  ))}
                  {xenialStatus.storeBreakdown.length > 6 && (
                    <Badge variant="outline" className="text-xs">
                      +{xenialStatus.storeBreakdown.length - 6} more
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">Unable to fetch POS status</div>
        )}

        <div className="flex items-center gap-3 pt-2 border-t">
          <Button
            onClick={() => refetchStatus()}
            variant="outline"
            data-testid="button-xenial-refresh"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh Status
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

interface HMEStatus {
  credentialsConfigured: boolean;
  missingCredentials: string[];
  dateChecked: string;
  restaurantsWithData: number;
  totalCarsToday: number;
  environment: string;
  isDeployment: boolean;
}

function HMESyncCard() {
  const { toast } = useToast();
  const [lastSyncResult, setLastSyncResult] = useState<string | null>(null);

  const { data: hmeStatus, isLoading: statusLoading, refetch: refetchStatus } = useQuery<HMEStatus>({
    queryKey: ["/api/hme/status"],
    refetchInterval: 30000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/hme/sync", {});
      return response.json() as Promise<{ message: string; status: string; saved: number; errors: string[] }>;
    },
    onSuccess: (data) => {
      setLastSyncResult(data.saved > 0 ? "success" : "warning");
      toast({
        title: data.saved > 0 ? "HME Sync Completed" : "Sync Completed - No Data",
        description: data.saved > 0 
          ? `Successfully synced ${data.saved} hourly records.${data.errors.length > 0 ? ` (${data.errors.length} warnings)` : ""}`
          : data.errors.length > 0 
            ? `No data saved. Issues: ${data.errors.slice(0, 3).join(", ")}${data.errors.length > 3 ? "..." : ""}`
            : "No drive-thru data available for the last 6 hours.",
        variant: data.saved > 0 ? "default" : "destructive",
      });
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    },
    onError: (error) => {
      setLastSyncResult("error");
      toast({
        title: "Sync Failed",
        description: error instanceof Error ? error.message : "Failed to sync HME data.",
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Timer className="h-5 w-5 text-primary" />
          <CardTitle>Drive-Thru Timer Sync (HME)</CardTitle>
        </div>
        <CardDescription>
          Manually sync drive-thru timing data from HME ZOOM timers. Data is also synced automatically every 5 minutes.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {statusLoading ? (
          <div className="text-muted-foreground text-sm">Loading HME status...</div>
        ) : hmeStatus ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Credentials:</span>
              {hmeStatus.credentialsConfigured ? (
                <Badge className="bg-green-500 hover:bg-green-600">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Missing: {hmeStatus.missingCredentials.join(", ")}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Today's Data:</span>
              <span className="text-sm text-muted-foreground">
                {hmeStatus.restaurantsWithData} restaurants with data, {hmeStatus.totalCarsToday} cars tracked
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Environment:</span>
              <Badge variant="outline">
                {hmeStatus.isDeployment ? "Production" : "Development"}
              </Badge>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">Unable to fetch HME status</div>
        )}

        <div className="flex items-center gap-3 pt-2 border-t">
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || !hmeStatus?.credentialsConfigured}
            data-testid="button-hme-sync"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "Syncing..." : "Sync Drive-Thru Data"}
          </Button>
          {lastSyncResult === "success" && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle className="h-4 w-4" />
              Sync triggered successfully
            </span>
          )}
          {lastSyncResult === "error" && (
            <span className="text-sm text-red-600 flex items-center gap-1">
              <AlertCircle className="h-4 w-4" />
              Sync failed
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
