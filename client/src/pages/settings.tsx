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
import { Settings, CalendarIcon, Save, Home, X, Car, Smartphone, Utensils, ShoppingBag, Timer, RefreshCw, CheckCircle, AlertCircle, Receipt, Clock, Database, Star, ExternalLink, Plus, Trash2, MapPin, Pencil, ThumbsUp, History, Eye, Send } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { format, differenceInDays, isFuture, parseISO } from "date-fns";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Restaurant, MarketWithRestaurants } from "@shared/schema";

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

  const googlePlaceIdMutation = useMutation({
    mutationFn: async ({ id, googlePlaceId }: { id: string; googlePlaceId: string | null }) => {
      return apiRequest("PATCH", `/api/restaurants/${id}`, { googlePlaceId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/restaurants"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      toast({
        title: "Google Place ID updated",
        description: "Changes saved successfully.",
      });
    },
    onError: () => {
      toast({
        title: "Error",
        description: "Failed to update Google Place ID.",
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

          <MarketsCard restaurants={restaurants || []} />

          <GoogleReviewsCard 
            restaurants={restaurants || []}
            onUpdatePlaceId={(id, placeId) => googlePlaceIdMutation.mutate({ id, googlePlaceId: placeId })}
            isPending={googlePlaceIdMutation.isPending}
          />

          <XenialSyncCard />

          <HMESyncCard />

          <GoogleReviewsSyncCard />

          <QualtricsOsatSyncCard />

          <EmailSubscribersCard />

          <ReportScheduleCard />

          <LeaderReportCard />
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

function GoogleReviewsCard({ 
  restaurants, 
  onUpdatePlaceId,
  isPending 
}: { 
  restaurants: Restaurant[];
  onUpdatePlaceId: (id: string, placeId: string | null) => void;
  isPending: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const { toast } = useToast();

  const syncMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/google/sync");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      toast({
        title: "Google Reviews synced",
        description: "Review data has been updated for all restaurants.",
      });
    },
    onError: () => {
      toast({
        title: "Sync failed",
        description: "Make sure GOOGLE_PLACES_API_KEY is configured.",
        variant: "destructive",
      });
    },
  });

  const startEditing = (restaurant: Restaurant) => {
    setEditingId(restaurant.id);
    setEditValue(restaurant.googlePlaceId || "");
  };

  const handleSave = (id: string) => {
    onUpdatePlaceId(id, editValue.trim() || null);
    setEditingId(null);
    setEditValue("");
  };

  const handleCancel = () => {
    setEditingId(null);
    setEditValue("");
  };

  // Sort restaurants by name for easier finding
  const sortedRestaurants = [...restaurants].sort((a, b) => a.name.localeCompare(b.name));
  const configuredCount = restaurants.filter(r => r.googlePlaceId).length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Star className="h-5 w-5 text-amber-500" />
            <CardTitle>Google Reviews</CardTitle>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            data-testid="button-sync-google-reviews"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            Sync Now
          </Button>
        </div>
        <CardDescription>
          Configure Google Place IDs to track review ratings for each restaurant.
          Reviews sync automatically every hour.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {/* Instructions */}
        <div className="bg-muted/50 rounded-lg p-4 text-sm">
          <p className="font-medium mb-2">How to find a Google Place ID:</p>
          <ol className="list-decimal list-inside space-y-1 text-muted-foreground mb-3">
            <li>Visit the Google Place ID Finder tool</li>
            <li>Search for the restaurant by name and location</li>
            <li>Click on the correct result on the map</li>
            <li>Copy the Place ID (starts with "ChIJ...")</li>
            <li>Paste it into the field below</li>
          </ol>
          <a
            href="https://developers.google.com/maps/documentation/javascript/examples/places-placeid-finder"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
            data-testid="link-place-id-finder"
          >
            <ExternalLink className="h-4 w-4" />
            Open Google Place ID Finder
          </a>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2">
          <Badge variant={configuredCount > 0 ? "default" : "secondary"}>
            {configuredCount} of {restaurants.length} configured
          </Badge>
        </div>

        {/* Restaurant list */}
        <div className="border rounded-lg divide-y max-h-96 overflow-y-auto">
          {sortedRestaurants.map(restaurant => (
            <div 
              key={restaurant.id} 
              className="flex items-center justify-between gap-3 p-3 hover-elevate"
              data-testid={`row-google-${restaurant.id}`}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm truncate">{restaurant.name}</div>
                {restaurant.googlePlaceId && !editingId && (
                  <div className="text-xs text-muted-foreground truncate">
                    {restaurant.googlePlaceId}
                  </div>
                )}
              </div>
              
              {editingId === restaurant.id ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    placeholder="ChIJ..."
                    className="w-48 h-8 text-xs"
                    data-testid={`input-place-id-${restaurant.id}`}
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSave(restaurant.id)}
                    disabled={isPending}
                    data-testid={`button-save-place-id-${restaurant.id}`}
                  >
                    <Save className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={handleCancel}
                    data-testid={`button-cancel-place-id-${restaurant.id}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  {restaurant.googlePlaceId ? (
                    <Badge variant="outline" className="text-green-600 border-green-600">
                      <CheckCircle className="h-3 w-3 mr-1" />
                      Configured
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-muted-foreground">
                      Not configured
                    </Badge>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => startEditing(restaurant)}
                    data-testid={`button-edit-place-id-${restaurant.id}`}
                  >
                    Edit
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
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

interface GoogleReviewsStatus {
  credentialsConfigured: boolean;
  configuredCount: number;
  totalRestaurants: number;
  restaurantsWithData: number;
  totalReviewsToday: number;
  dateChecked: string;
}

function GoogleReviewsSyncCard() {
  const { toast } = useToast();
  const [lastSyncResult, setLastSyncResult] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<GoogleReviewsStatus>({
    queryKey: ["/api/google-reviews/status"],
    refetchInterval: 30000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/google-reviews/sync", {});
      return response.json() as Promise<{ message: string; success: number; failed: number }>;
    },
    onSuccess: (data) => {
      setLastSyncResult(data.success > 0 ? "success" : "warning");
      toast({
        title: data.success > 0 ? "Google Reviews Synced" : "Sync Completed - No Data",
        description: data.success > 0 
          ? `Successfully synced ${data.success} restaurants.${data.failed > 0 ? ` (${data.failed} failed)` : ""}`
          : data.failed > 0 
            ? `No data synced. ${data.failed} restaurants failed.`
            : "No restaurants configured with Place IDs.",
        variant: data.success > 0 ? "default" : "destructive",
      });
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    },
    onError: (error) => {
      setLastSyncResult("error");
      toast({
        title: "Sync Failed",
        description: error instanceof Error ? error.message : "Failed to sync Google reviews.",
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Star className="h-5 w-5 text-primary" />
          <CardTitle>Google Reviews Sync</CardTitle>
        </div>
        <CardDescription>
          Review data is synced automatically every hour. Shows rating and review count for each restaurant.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {statusLoading ? (
          <div className="text-muted-foreground text-sm">Loading Google Reviews status...</div>
        ) : status ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">API Key:</span>
              {status.credentialsConfigured ? (
                <Badge className="bg-green-500 hover:bg-green-600">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Missing GOOGLE_PLACES_API_KEY
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Place IDs:</span>
              <span className="text-sm text-muted-foreground">
                {status.configuredCount} of {status.totalRestaurants} restaurants configured
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Today's Data:</span>
              <span className="text-sm text-muted-foreground">
                {status.restaurantsWithData} restaurants synced, {status.totalReviewsToday.toLocaleString()} total reviews
              </span>
            </div>
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">Unable to fetch Google Reviews status</div>
        )}

        <div className="flex items-center gap-3 pt-2 border-t">
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || !status?.credentialsConfigured}
            data-testid="button-google-sync"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "Syncing..." : "Sync Reviews Now"}
          </Button>
          {lastSyncResult === "success" && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle className="h-4 w-4" />
              Sync completed
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

interface OsatStatus {
  credentialsConfigured: boolean;
  surveyIdConfigured: boolean;
  restaurantsWithData: number;
  totalResponses: number;
  avgOsat: string | null;
  dateChecked: string;
  lastSync: string | null;
}

function QualtricsOsatSyncCard() {
  const { toast } = useToast();
  const [lastSyncResult, setLastSyncResult] = useState<string | null>(null);

  const { data: status, isLoading: statusLoading, refetch: refetchStatus } = useQuery<OsatStatus>({
    queryKey: ["/api/osat/status"],
    refetchInterval: 30000,
  });

  const syncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/osat/sync", { daysBack: 3 });
      return response.json() as Promise<{ message: string; synced: number; daysBack: number; errors: string[] }>;
    },
    onSuccess: (data) => {
      setLastSyncResult(data.synced > 0 ? "success" : "warning");
      toast({
        title: data.synced > 0 ? "OSAT Data Synced" : "Sync Completed - No Data",
        description: data.synced > 0 
          ? `Successfully synced ${data.synced} restaurant OSAT records (${data.daysBack} days).${data.errors.length > 0 ? ` (${data.errors.length} errors)` : ""}`
          : data.errors.length > 0 
            ? `No data synced. ${data.errors.length} errors encountered.`
            : "No survey responses found.",
        variant: data.synced > 0 ? "default" : "destructive",
      });
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    },
    onError: (error) => {
      setLastSyncResult("error");
      toast({
        title: "Sync Failed",
        description: error instanceof Error ? error.message : "Failed to sync OSAT data from Qualtrics.",
        variant: "destructive",
      });
    },
  });

  const historicalSyncMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/osat/sync-historical", { daysBack: 7 });
      return response.json() as Promise<{ message: string; synced: number; daysBack: number; errors: string[] }>;
    },
    onSuccess: (data) => {
      setLastSyncResult(data.synced > 0 ? "success" : "warning");
      toast({
        title: "Historical OSAT Sync Complete",
        description: data.synced > 0 
          ? `Successfully synced ${data.synced} restaurant OSAT records (${data.daysBack} days of history).`
          : "No historical survey responses found.",
        variant: data.synced > 0 ? "default" : "destructive",
      });
      refetchStatus();
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
    },
    onError: (error) => {
      setLastSyncResult("error");
      toast({
        title: "Historical Sync Failed",
        description: error instanceof Error ? error.message : "Failed to sync historical OSAT data.",
        variant: "destructive",
      });
    },
  });

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ThumbsUp className="h-5 w-5 text-primary" />
          <CardTitle>Customer Satisfaction (OSAT) Sync</CardTitle>
        </div>
        <CardDescription>
          Syncs survey responses from Qualtrics to track customer satisfaction scores. Surveys are assigned to the hour of the customer visit for detailed hourly analysis.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {statusLoading ? (
          <div className="text-muted-foreground text-sm">Loading OSAT status...</div>
        ) : status ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Credentials:</span>
              {status.credentialsConfigured ? (
                <Badge className="bg-green-500 hover:bg-green-600">
                  <CheckCircle className="h-3 w-3 mr-1" />
                  Configured
                </Badge>
              ) : (
                <Badge variant="destructive">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  Missing {!status.surveyIdConfigured ? "QUALTRICS_SURVEY_ID" : "QUALTRICS_API_TOKEN"}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-medium">Today's Data:</span>
              <span className="text-sm text-muted-foreground">
                {status.restaurantsWithData} restaurants, {status.totalResponses} responses
                {status.avgOsat && ` (${status.avgOsat}% avg OSAT)`}
              </span>
            </div>
            {status.lastSync && (
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-medium">Last Sync:</span>
                <span className="text-sm text-muted-foreground">
                  {format(new Date(status.lastSync), "MMM d, h:mm a")}
                </span>
              </div>
            )}
          </div>
        ) : (
          <div className="text-muted-foreground text-sm">Unable to fetch OSAT status</div>
        )}

        <div className="flex items-center gap-3 pt-2 border-t flex-wrap">
          <Button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || historicalSyncMutation.isPending || !status?.credentialsConfigured}
            data-testid="button-osat-sync"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncMutation.isPending ? "animate-spin" : ""}`} />
            {syncMutation.isPending ? "Syncing..." : "Sync Last 3 Days"}
          </Button>
          <Button
            variant="outline"
            onClick={() => historicalSyncMutation.mutate()}
            disabled={syncMutation.isPending || historicalSyncMutation.isPending || !status?.credentialsConfigured}
            data-testid="button-osat-sync-historical"
          >
            <History className={`h-4 w-4 mr-2 ${historicalSyncMutation.isPending ? "animate-spin" : ""}`} />
            {historicalSyncMutation.isPending ? "Syncing..." : "Sync 7 Days"}
          </Button>
          {lastSyncResult === "success" && (
            <span className="text-sm text-green-600 flex items-center gap-1">
              <CheckCircle className="h-4 w-4" />
              Sync completed
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

// Color options for markets
const MARKET_COLORS = [
  { value: "#6366f1", label: "Indigo" },
  { value: "#8b5cf6", label: "Purple" },
  { value: "#06b6d4", label: "Cyan" },
  { value: "#10b981", label: "Emerald" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#ef4444", label: "Red" },
  { value: "#ec4899", label: "Pink" },
  { value: "#64748b", label: "Slate" },
];

function MarketsCard({ restaurants }: { restaurants: Restaurant[] }) {
  const { toast } = useToast();
  const [isCreating, setIsCreating] = useState(false);
  const [editingMarket, setEditingMarket] = useState<string | null>(null);
  const [newMarketName, setNewMarketName] = useState("");
  const [newMarketColor, setNewMarketColor] = useState("#6366f1");
  const [editMarketName, setEditMarketName] = useState("");
  const [editMarketColor, setEditMarketColor] = useState("");
  const [selectedRestaurants, setSelectedRestaurants] = useState<string[]>([]);

  const { data: markets, isLoading } = useQuery<MarketWithRestaurants[]>({
    queryKey: ["/api/markets"],
  });

  const createMutation = useMutation({
    mutationFn: async ({ name, color }: { name: string; color: string }) => {
      return apiRequest("POST", "/api/markets", { name, color });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/markets"] });
      setIsCreating(false);
      setNewMarketName("");
      setNewMarketColor("#6366f1");
      toast({ title: "Market created", description: "New market has been created." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create market.", variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, name, color, restaurantIds }: { id: string; name?: string; color?: string; restaurantIds?: string[] }) => {
      return apiRequest("PATCH", `/api/markets/${id}`, { name, color, restaurantIds });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/markets"] });
      setEditingMarket(null);
      toast({ title: "Market updated", description: "Changes saved successfully." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update market.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/markets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/markets"] });
      toast({ title: "Market deleted", description: "Market has been removed." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete market.", variant: "destructive" });
    },
  });

  const startEditing = (market: MarketWithRestaurants) => {
    setEditingMarket(market.id);
    setEditMarketName(market.name);
    setEditMarketColor(market.color || "#6366f1");
    setSelectedRestaurants(market.restaurantIds || []);
  };

  const handleSaveEdit = (id: string) => {
    updateMutation.mutate({
      id,
      name: editMarketName,
      color: editMarketColor,
      restaurantIds: selectedRestaurants,
    });
  };

  const toggleRestaurant = (restaurantId: string) => {
    setSelectedRestaurants(prev => 
      prev.includes(restaurantId) 
        ? prev.filter(id => id !== restaurantId)
        : [...prev, restaurantId]
    );
  };

  const sortedRestaurants = [...restaurants].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-primary" />
            <CardTitle>Markets</CardTitle>
          </div>
          {!isCreating && (
            <Button
              size="sm"
              onClick={() => setIsCreating(true)}
              data-testid="button-create-market"
            >
              <Plus className="h-4 w-4 mr-2" />
              New Market
            </Button>
          )}
        </div>
        <CardDescription>
          Group restaurants into markets for multi-unit management. Filter the dashboard by market to see only your units.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {isCreating && (
          <div className="p-4 border rounded-lg bg-muted/50 space-y-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Input
                placeholder="Market name"
                value={newMarketName}
                onChange={(e) => setNewMarketName(e.target.value)}
                className="max-w-xs"
                data-testid="input-market-name"
              />
              <div className="flex items-center gap-2">
                {MARKET_COLORS.map((color) => (
                  <button
                    key={color.value}
                    type="button"
                    onClick={() => setNewMarketColor(color.value)}
                    className={`w-6 h-6 rounded-full border-2 transition-all ${
                      newMarketColor === color.value ? "border-foreground scale-110" : "border-transparent"
                    }`}
                    style={{ backgroundColor: color.value }}
                    title={color.label}
                    data-testid={`color-${color.value}`}
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => createMutation.mutate({ name: newMarketName, color: newMarketColor })}
                disabled={!newMarketName.trim() || createMutation.isPending}
                data-testid="button-save-market"
              >
                <Save className="h-4 w-4 mr-1" />
                Create
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setIsCreating(false);
                  setNewMarketName("");
                  setNewMarketColor("#6366f1");
                }}
                data-testid="button-cancel-market"
              >
                Cancel
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-muted-foreground text-sm">Loading markets...</div>
        ) : markets && markets.length > 0 ? (
          <div className="grid gap-3">
            {markets.map((market) => (
              <div
                key={market.id}
                className="p-4 border rounded-lg bg-card hover-elevate"
                data-testid={`market-${market.id}`}
              >
                {editingMarket === market.id ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Input
                        value={editMarketName}
                        onChange={(e) => setEditMarketName(e.target.value)}
                        className="max-w-xs"
                        data-testid="input-edit-market-name"
                      />
                      <div className="flex items-center gap-2">
                        {MARKET_COLORS.map((color) => (
                          <button
                            key={color.value}
                            type="button"
                            onClick={() => setEditMarketColor(color.value)}
                            className={`w-6 h-6 rounded-full border-2 transition-all ${
                              editMarketColor === color.value ? "border-foreground scale-110" : "border-transparent"
                            }`}
                            style={{ backgroundColor: color.value }}
                            title={color.label}
                          />
                        ))}
                      </div>
                    </div>
                    
                    <div>
                      <Label className="text-sm font-medium mb-2 block">Assign Restaurants:</Label>
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 max-h-60 overflow-y-auto p-2 border rounded">
                        {sortedRestaurants.map((restaurant) => (
                          <div key={restaurant.id} className="flex items-center gap-2">
                            <Checkbox
                              id={`market-${market.id}-restaurant-${restaurant.id}`}
                              checked={selectedRestaurants.includes(restaurant.id)}
                              onCheckedChange={() => toggleRestaurant(restaurant.id)}
                              data-testid={`checkbox-restaurant-${restaurant.id}`}
                            />
                            <label
                              htmlFor={`market-${market.id}-restaurant-${restaurant.id}`}
                              className="text-sm cursor-pointer truncate"
                            >
                              {restaurant.name}
                            </label>
                          </div>
                        ))}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        onClick={() => handleSaveEdit(market.id)}
                        disabled={updateMutation.isPending}
                        data-testid="button-save-edit-market"
                      >
                        <Save className="h-4 w-4 mr-1" />
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditingMarket(null)}
                        data-testid="button-cancel-edit-market"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-4 h-4 rounded-full shrink-0"
                        style={{ backgroundColor: market.color || "#6366f1" }}
                      />
                      <span className="font-medium">{market.name}</span>
                      <Badge variant="secondary" className="text-xs">
                        {market.restaurantIds?.length || 0} units
                      </Badge>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          startEditing(market);
                        }}
                        data-testid={`button-edit-market-${market.id}`}
                      >
                        <Pencil className="h-4 w-4 mr-1" />
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          deleteMutation.mutate(market.id);
                        }}
                        disabled={deleteMutation.isPending}
                        data-testid={`button-delete-market-${market.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-6 text-muted-foreground">
            <MapPin className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>No markets created yet.</p>
            <p className="text-sm">Create a market to group restaurants for easier filtering.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface EmailSubscriber {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  reportTime: string;
  createdAt: string;
}

function EmailSubscribersCard() {
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { data: subscribers, isLoading } = useQuery<EmailSubscriber[]>({
    queryKey: ["/api/email-subscribers"],
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/email-subscribers", {
        email: newEmail.trim(),
        name: newName.trim() || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      setNewEmail("");
      setNewName("");
      toast({ title: "Subscriber added", description: "Daily reports will be sent to this email." });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error?.message || "Failed to add subscriber", variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return apiRequest("PATCH", `/api/email-subscribers/${id}`, { isActive });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/email-subscribers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      toast({ title: "Subscriber removed" });
    },
  });

  const sendNowMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/daily-report/send-now");
    },
    onSuccess: async (response) => {
      const data = await response.json();
      toast({
        title: "Report sent",
        description: `${data.sent} email(s) sent, ${data.failed} failed.`,
      });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error?.message || "Failed to send report", variant: "destructive" });
    },
  });

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/daily-report/preview");
      if (!res.ok) {
        const err = await res.json();
        toast({ title: "No preview available", description: err.error || "No data for yesterday", variant: "destructive" });
        setPreviewHtml(null);
      } else {
        const html = await res.text();
        setPreviewHtml(html);
      }
      setShowPreview(true);
    } catch {
      toast({ title: "Error", description: "Failed to load preview", variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Daily Report Subscribers
          </CardTitle>
          <CardDescription>
            Manage email addresses that receive the daily performance summary at 6:00 AM Central.
          </CardDescription>
        </div>
        <div className="flex gap-2 flex-wrap shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={loadPreview}
            disabled={previewLoading}
            data-testid="button-preview-report"
          >
            <Eye className="h-4 w-4 mr-1" />
            {previewLoading ? "Loading..." : "Preview"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => sendNowMutation.mutate()}
            disabled={sendNowMutation.isPending || !subscribers || subscribers.length === 0}
            data-testid="button-send-report-now"
          >
            <Send className="h-4 w-4 mr-1" />
            {sendNowMutation.isPending ? "Sending..." : "Send Now"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <Input
              type="text"
              placeholder="Name (optional)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="w-40"
              data-testid="input-subscriber-name"
            />
            <Input
              type="email"
              placeholder="Email address"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="flex-1 min-w-[200px]"
              data-testid="input-subscriber-email"
            />
            <Button
              onClick={() => addMutation.mutate()}
              disabled={!newEmail.trim() || addMutation.isPending}
              data-testid="button-add-subscriber"
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>

          {isLoading ? (
            <div className="text-center py-4 text-muted-foreground text-sm">Loading subscribers...</div>
          ) : subscribers && subscribers.length > 0 ? (
            <div className="space-y-2">
              {subscribers.map((sub) => (
                <div
                  key={sub.id}
                  className="flex items-center gap-3 p-3 rounded-md border"
                  data-testid={`row-subscriber-${sub.id}`}
                >
                  <Checkbox
                    checked={sub.isActive}
                    onCheckedChange={(checked) => {
                      toggleMutation.mutate({ id: sub.id, isActive: !!checked });
                    }}
                    data-testid={`checkbox-subscriber-active-${sub.id}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {sub.name || sub.email}
                    </div>
                    {sub.name && (
                      <div className="text-xs text-muted-foreground truncate">{sub.email}</div>
                    )}
                  </div>
                  <Badge variant={sub.isActive ? "default" : "secondary"} className="shrink-0">
                    {sub.isActive ? "Active" : "Paused"}
                  </Badge>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => removeMutation.mutate(sub.id)}
                    disabled={removeMutation.isPending}
                    data-testid={`button-remove-subscriber-${sub.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-6 text-muted-foreground">
              <Receipt className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p>No subscribers yet.</p>
              <p className="text-sm">Add email addresses to receive daily performance reports.</p>
            </div>
          )}

          {showPreview && (
            <div className="mt-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Report Preview (Yesterday)</span>
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => { setShowPreview(false); setPreviewHtml(null); }}
                  data-testid="button-close-preview"
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {previewHtml ? (
                <div className="border rounded-md overflow-hidden">
                  <iframe
                    srcDoc={previewHtml}
                    className="w-full border-0"
                    style={{ height: "600px" }}
                    title="Daily Report Preview"
                    data-testid="iframe-report-preview"
                  />
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground border rounded-md">
                  <Receipt className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No report data available for yesterday.</p>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LeaderReportCard() {
  const { toast } = useToast();
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { data: subscribers } = useQuery<EmailSubscriber[]>({
    queryKey: ["/api/email-subscribers"],
  });

  const sendNowMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/leader-report/send-now");
    },
    onSuccess: async (response) => {
      const data = await response.json();
      toast({
        title: "Leader report sent",
        description: `${data.sent} email(s) sent, ${data.failed} failed.`,
      });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error?.message || "Failed to send leader report", variant: "destructive" });
    },
  });

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/leader-report/preview");
      if (!res.ok) {
        const err = await res.json();
        toast({ title: "No preview available", description: err.error || "No leader data available", variant: "destructive" });
        setPreviewHtml(null);
      } else {
        const html = await res.text();
        setPreviewHtml(html);
      }
      setShowPreview(true);
    } catch {
      toast({ title: "Error", description: "Failed to load preview", variant: "destructive" });
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Star className="h-5 w-5" />
            Leader Rankings Report
          </CardTitle>
          <CardDescription>
            Top 10 company-wide leaders and per-store rankings with overall position. Uses same subscriber list as the daily report.
          </CardDescription>
        </div>
        <div className="flex gap-2 flex-wrap shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={loadPreview}
            disabled={previewLoading}
            data-testid="button-preview-leader-report"
          >
            <Eye className="h-4 w-4 mr-1" />
            {previewLoading ? "Loading..." : "Preview"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => sendNowMutation.mutate()}
            disabled={sendNowMutation.isPending || !subscribers || subscribers.length === 0}
            data-testid="button-send-leader-report-now"
          >
            <Send className="h-4 w-4 mr-1" />
            {sendNowMutation.isPending ? "Sending..." : "Send Now"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {showPreview && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Leader Report Preview (Last 7 Days)</span>
              <Button
                size="icon"
                variant="ghost"
                onClick={() => { setShowPreview(false); setPreviewHtml(null); }}
                data-testid="button-close-leader-preview"
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            {previewHtml ? (
              <div className="border rounded-md overflow-hidden">
                <iframe
                  srcDoc={previewHtml}
                  className="w-full border-0"
                  style={{ height: "700px" }}
                  title="Leader Report Preview"
                  data-testid="iframe-leader-report-preview"
                />
              </div>
            ) : (
              <div className="text-center py-8 text-muted-foreground border rounded-md">
                <Star className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No leader data available for this period.</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface ReportSchedule {
  id: string;
  reportType: string;
  sendHour: number;
  sendMinute: number;
  isEnabled: boolean;
  updatedAt: string | null;
}

function ReportScheduleCard() {
  const { toast } = useToast();

  const { data: schedules, isLoading } = useQuery<ReportSchedule[]>({
    queryKey: ["/api/report-schedules"],
  });

  const updateMutation = useMutation({
    mutationFn: async ({ reportType, sendHour, sendMinute, isEnabled }: { reportType: string; sendHour?: number; sendMinute?: number; isEnabled?: boolean }) => {
      return apiRequest("PATCH", `/api/report-schedules/${reportType}`, { sendHour, sendMinute, isEnabled });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/report-schedules"] });
      toast({ title: "Schedule updated" });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error?.message || "Failed to update schedule", variant: "destructive" });
    },
  });

  const dailySchedule = schedules?.find(s => s.reportType === 'daily_report');
  const leaderSchedule = schedules?.find(s => s.reportType === 'leader_report');

  const formatTime = (hour: number, minute: number) => {
    const h = hour.toString().padStart(2, '0');
    const m = minute.toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  const handleTimeChange = (reportType: string, timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      updateMutation.mutate({ reportType, sendHour: h, sendMinute: m });
    }
  };

  const handleToggle = (reportType: string, checked: boolean) => {
    updateMutation.mutate({ reportType, isEnabled: checked });
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Report Send Schedule
          </CardTitle>
          <CardDescription>Configure when daily and leader ranking reports are sent (Central Time).</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading schedules...</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 p-3 border rounded-md" data-testid="schedule-daily-report">
              <div className="flex items-center gap-3 min-w-0">
                <Checkbox
                  checked={dailySchedule?.isEnabled ?? true}
                  onCheckedChange={(checked) => handleToggle('daily_report', checked === true)}
                  data-testid="checkbox-daily-report-enabled"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Daily Performance Report</p>
                  <p className="text-xs text-muted-foreground">Summary of yesterday's sales, grades, and insights</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Send at</Label>
                <Input
                  type="time"
                  className="w-28"
                  value={formatTime(dailySchedule?.sendHour ?? 6, dailySchedule?.sendMinute ?? 0)}
                  onChange={(e) => handleTimeChange('daily_report', e.target.value)}
                  disabled={!(dailySchedule?.isEnabled ?? true)}
                  data-testid="input-daily-report-time"
                />
                <span className="text-xs text-muted-foreground">CT</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4 p-3 border rounded-md" data-testid="schedule-leader-report">
              <div className="flex items-center gap-3 min-w-0">
                <Checkbox
                  checked={leaderSchedule?.isEnabled ?? true}
                  onCheckedChange={(checked) => handleToggle('leader_report', checked === true)}
                  data-testid="checkbox-leader-report-enabled"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Leader Rankings Report</p>
                  <p className="text-xs text-muted-foreground">Top 10 leaders and per-store rankings</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Send at</Label>
                <Input
                  type="time"
                  className="w-28"
                  value={formatTime(leaderSchedule?.sendHour ?? 6, leaderSchedule?.sendMinute ?? 0)}
                  onChange={(e) => handleTimeChange('leader_report', e.target.value)}
                  disabled={!(leaderSchedule?.isEnabled ?? true)}
                  data-testid="input-leader-report-time"
                />
                <span className="text-xs text-muted-foreground">CT</span>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
