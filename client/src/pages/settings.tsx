import { useState, type ReactNode } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
import { Settings, CalendarIcon, Save, Home, X, Car, Smartphone, Utensils, ShoppingBag, Timer, RefreshCw, CheckCircle, AlertCircle, Receipt, Clock, Database, Star, ExternalLink, Plus, Trash2, MapPin, Pencil, ThumbsUp, History, Eye, Send, ChevronDown, Upload, FileUp, Users, Shield, ShieldOff, Megaphone, BarChart3, Zap, Vote, Award } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { NavBar } from "@/components/nav-bar";
import { format, differenceInDays, isFuture, parseISO, formatDistanceToNow } from "date-fns";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Restaurant, MarketWithRestaurants, TickerMessage, PollWithResults, GradingConfigData, ScoringTier } from "@shared/schema";
import { DEFAULT_GRADING_CONFIG } from "@shared/schema";

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

function CollapsibleCard({ title, description, icon, children, defaultOpen = false, actions }: {
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0 pb-3" data-testid={`trigger-${title.toLowerCase().replace(/\s+/g, '-')}`}>
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2">
                {icon}
                {title}
              </CardTitle>
              {description && <CardDescription className="mt-1">{description}</CardDescription>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {actions && <div onClick={(e) => e.stopPropagation()}>{actions}</div>}
              <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>{children}</CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

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
  today.setHours(0, 0, 0, 0);
  
  if (openDate > today) {
    return { status: "training" };
  }
  
  const daysOpen = differenceInDays(today, openDate);
  if (daysOpen < 120) {
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
    if (restaurant.openDate) {
      const [year, month, day] = restaurant.openDate.split('-').map(Number);
      setEditDate(new Date(year, month - 1, day));
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
            <NavBar />
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6">
        <div className="grid gap-6">
          <Collapsible defaultOpen={false} data-testid="collapsible-restaurant-management">
            <Card>
              <CollapsibleTrigger asChild data-testid="trigger-restaurant-management">
                <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle>Restaurant Open Dates</CardTitle>
                    <CardDescription>
                      Set open dates for each restaurant. Units with future dates are in training mode (excluded from rankings).
                      Units less than 120 days old show a "NEW UNIT" badge.
                    </CardDescription>
                  </div>
                  <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
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
                            ({newUnits.length} units - less than 120 days old)
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
              </CollapsibleContent>
            </Card>
          </Collapsible>

          <Collapsible defaultOpen={false} data-testid="collapsible-status-definitions">
            <Card>
              <CollapsibleTrigger asChild data-testid="trigger-status-definitions">
                <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
                  <div>
                    <CardTitle>Status Definitions</CardTitle>
                  </div>
                  <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
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
                        Open date is within the last 120 days. These units are included in rankings with a "NEW UNIT" badge.
                        The badge is automatically removed after 120 days.
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <div className="w-[70px]"></div>
                    <div>
                      <p className="font-medium">Established Units</p>
                      <p className="text-sm text-muted-foreground">
                        Open date is more than 120 days ago (or not set). These units are fully included in all rankings and comparisons.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

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

          <DailyReportCard />

          <LeaderReportCard />

          <PushReportCard />

          <SalesSummaryReportCard />

          <HistoricalSalesUploadCard />

          <SalesPlanUploadCard />

          <TickerMessagesCard />

          <MilestoneConfigCard />

          <PollManagementCard />

          <GradingConfigCard />

          <HelperRewardsCard />

          <UserManagementCard />
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
  todayOrderCount?: number;
  todaySalesTotal?: number;
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
      const response = await apiRequest("POST", "/api/google-reviews/sync", {});
      return response.json() as Promise<{ message: string; success: number; failed: number; errors?: string[] }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/google-reviews/status"] });
      if (data.failed > 0 && data.success === 0) {
        toast({
          title: "Sync failed",
          description: data.errors?.[0] || `${data.failed} restaurants failed to sync.`,
          variant: "destructive",
        });
      } else {
        toast({
          title: "Google Reviews synced",
          description: data.failed > 0
            ? `Updated ${data.success} restaurants. ${data.failed} failed: ${data.errors?.[0] || "see logs"}`
            : `Updated ${data.success} restaurants.`,
        });
      }
    },
    onError: (error) => {
      toast({
        title: "Sync failed",
        description: error instanceof Error ? error.message : "Unable to reach the sync endpoint.",
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

  const sortedRestaurants = [...restaurants].sort((a, b) => a.name.localeCompare(b.name));
  const configuredCount = restaurants.filter(r => r.googlePlaceId).length;

  return (
    <Collapsible data-testid="collapsible-google-reviews">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-google-reviews">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Star className="h-5 w-5 text-amber-500" />
                Google Reviews
              </CardTitle>
              <CardDescription>
                Configure Google Place IDs to track review ratings for each restaurant.
                Reviews sync automatically every hour.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="grid gap-4">
            <div className="flex items-center justify-end gap-2">
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

            <div className="flex items-center gap-2">
              <Badge variant={configuredCount > 0 ? "default" : "secondary"}>
                {configuredCount} of {restaurants.length} configured
              </Badge>
            </div>

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
        </CollapsibleContent>
      </Card>
    </Collapsible>
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
    <Collapsible data-testid="collapsible-xenial-sync">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-xenial-sync">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Receipt className="h-5 w-5 text-primary" />
                Xenial POS Orders
              </CardTitle>
              <CardDescription>
                Live order data from Xenial POS systems. Data is synced from the shared production database.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
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
    <Collapsible data-testid="collapsible-hme-sync">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-hme-sync">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Timer className="h-5 w-5 text-primary" />
                Drive-Thru Timer Sync (HME)
              </CardTitle>
              <CardDescription>
                Manually sync drive-thru timing data from HME ZOOM timers. Data is also synced automatically every 5 minutes.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
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
      return response.json() as Promise<{ message: string; success: number; failed: number; errors?: string[] }>;
    },
    onSuccess: (data) => {
      setLastSyncResult(data.success > 0 ? "success" : "warning");
      const firstErr = data.errors?.[0];
      toast({
        title: data.success > 0 ? "Google Reviews Synced" : "Sync Failed",
        description: data.success > 0
          ? `Successfully synced ${data.success} restaurants.${data.failed > 0 ? ` (${data.failed} failed: ${firstErr || "see logs"})` : ""}`
          : data.failed > 0
            ? firstErr || `No data synced. ${data.failed} restaurants failed.`
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
    <Collapsible data-testid="collapsible-google-reviews-sync">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-google-reviews-sync">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Star className="h-5 w-5 text-primary" />
                Google Reviews Sync
              </CardTitle>
              <CardDescription>
                Review data is synced automatically every hour. Shows rating and review count for each restaurant.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
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
    <Collapsible data-testid="collapsible-qualtrics-osat">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-qualtrics-osat">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <ThumbsUp className="h-5 w-5 text-primary" />
                Customer Satisfaction (OSAT) Sync
              </CardTitle>
              <CardDescription>
                Syncs survey responses from Qualtrics to track customer satisfaction scores. Surveys are assigned to the hour of the customer visit for detailed hourly analysis.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

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
    <Collapsible data-testid="collapsible-markets">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-markets">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <MapPin className="h-5 w-5 text-primary" />
                Markets
              </CardTitle>
              <CardDescription>
                Group restaurants into markets for multi-unit management. Filter the dashboard by market to see only your units.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="grid gap-4">
            <div className="flex items-center justify-end">
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

interface EmailSubscriber {
  id: string;
  email: string;
  name: string | null;
  isActive: boolean;
  reportTime: string;
  reportTypes: string[];
  createdAt: string;
}

interface ReportSchedule {
  id: string;
  reportType: string;
  sendHour: number;
  sendMinute: number;
  isEnabled: boolean;
  updatedAt: string | null;
}

function DailyReportCard() {
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { data: subscribers, isLoading: subscribersLoading } = useQuery<EmailSubscriber[]>({
    queryKey: ["/api/email-subscribers"],
  });

  const { data: schedules, isLoading: schedulesLoading } = useQuery<ReportSchedule[]>({
    queryKey: ["/api/report-schedules"],
  });

  const dailySchedule = schedules?.find(s => s.reportType === 'daily_report');
  const dailySubscribers = (subscribers || []).filter(s => s.reportTypes?.includes('daily_report'));

  const scheduleUpdateMutation = useMutation({
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

  const addMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/email-subscribers", {
        email: newEmail.trim(),
        name: newName.trim() || null,
        reportTypes: ['daily_report'],
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
    mutationFn: async (sub: EmailSubscriber) => {
      const remaining = (sub.reportTypes || []).filter(t => t !== 'daily_report');
      if (remaining.length === 0) {
        return apiRequest("DELETE", `/api/email-subscribers/${sub.id}`);
      }
      return apiRequest("PATCH", `/api/email-subscribers/${sub.id}`, { reportTypes: remaining });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      toast({ title: "Subscriber removed from daily report" });
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

  const formatScheduleTime = (hour: number, minute: number) => {
    const h = hour.toString().padStart(2, '0');
    const m = minute.toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  const handleTimeChange = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      scheduleUpdateMutation.mutate({ reportType: 'daily_report', sendHour: h, sendMinute: m });
    }
  };

  const handleToggleSchedule = (checked: boolean) => {
    scheduleUpdateMutation.mutate({ reportType: 'daily_report', isEnabled: checked });
  };

  return (
    <Collapsible data-testid="collapsible-daily-report">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-daily-report">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Receipt className="h-5 w-5" />
                Daily Performance Report
              </CardTitle>
              <CardDescription>
                Summary of yesterday's sales, grades, and insights sent to subscribers.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between gap-4 p-3 border rounded-md" data-testid="schedule-daily-report">
              <div className="flex items-center gap-3 min-w-0">
                <Checkbox
                  checked={dailySchedule?.isEnabled ?? true}
                  onCheckedChange={(checked) => handleToggleSchedule(checked === true)}
                  data-testid="checkbox-daily-report-enabled"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Automated Sending</p>
                  <p className="text-xs text-muted-foreground">Enable or disable scheduled delivery</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Send at</Label>
                <Input
                  type="time"
                  className="w-28"
                  value={formatScheduleTime(dailySchedule?.sendHour ?? 6, dailySchedule?.sendMinute ?? 0)}
                  onChange={(e) => handleTimeChange(e.target.value)}
                  disabled={!(dailySchedule?.isEnabled ?? true)}
                  data-testid="input-daily-report-time"
                />
                <span className="text-xs text-muted-foreground">CT</span>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium">Subscribers</h4>
              <div className="flex gap-2 flex-wrap">
                <Input
                  type="text"
                  placeholder="Name (optional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-40"
                  data-testid="input-daily-subscriber-name"
                />
                <Input
                  type="email"
                  placeholder="Email address"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="flex-1 min-w-[200px]"
                  data-testid="input-daily-subscriber-email"
                />
                <Button
                  onClick={() => addMutation.mutate()}
                  disabled={!newEmail.trim() || addMutation.isPending}
                  data-testid="button-add-daily-subscriber"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>

              {subscribersLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Loading subscribers...</div>
              ) : dailySubscribers.length > 0 ? (
                <div className="space-y-2">
                  {dailySubscribers.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center gap-3 p-3 rounded-md border"
                      data-testid={`row-daily-subscriber-${sub.id}`}
                    >
                      <Checkbox
                        checked={sub.isActive}
                        onCheckedChange={(checked) => {
                          toggleMutation.mutate({ id: sub.id, isActive: !!checked });
                        }}
                        data-testid={`checkbox-daily-subscriber-active-${sub.id}`}
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
                        onClick={() => removeMutation.mutate(sub)}
                        disabled={removeMutation.isPending}
                        data-testid={`button-remove-daily-subscriber-${sub.id}`}
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
            </div>

            <div className="flex gap-2 flex-wrap pt-2 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={loadPreview}
                disabled={previewLoading}
                data-testid="button-preview-daily-report"
              >
                <Eye className="h-4 w-4 mr-1" />
                {previewLoading ? "Loading..." : "Preview"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => sendNowMutation.mutate()}
                disabled={sendNowMutation.isPending || dailySubscribers.length === 0}
                data-testid="button-send-daily-report-now"
              >
                <Send className="h-4 w-4 mr-1" />
                {sendNowMutation.isPending ? "Sending..." : "Send Now"}
              </Button>
            </div>

            {showPreview && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Report Preview (Yesterday)</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => { setShowPreview(false); setPreviewHtml(null); }}
                    data-testid="button-close-daily-preview"
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
                      data-testid="iframe-daily-report-preview"
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
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function LeaderReportCard() {
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { data: subscribers, isLoading: subscribersLoading } = useQuery<EmailSubscriber[]>({
    queryKey: ["/api/email-subscribers"],
  });

  const { data: schedules, isLoading: schedulesLoading } = useQuery<ReportSchedule[]>({
    queryKey: ["/api/report-schedules"],
  });

  const leaderSchedule = schedules?.find(s => s.reportType === 'leader_report');
  const leaderSubscribers = (subscribers || []).filter(s => s.reportTypes?.includes('leader_report'));

  const scheduleUpdateMutation = useMutation({
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

  const addMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/email-subscribers", {
        email: newEmail.trim(),
        name: newName.trim() || null,
        reportTypes: ['leader_report'],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      setNewEmail("");
      setNewName("");
      toast({ title: "Subscriber added", description: "Leader reports will be sent to this email." });
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
    mutationFn: async (sub: EmailSubscriber) => {
      const remaining = (sub.reportTypes || []).filter(t => t !== 'leader_report');
      if (remaining.length === 0) {
        return apiRequest("DELETE", `/api/email-subscribers/${sub.id}`);
      }
      return apiRequest("PATCH", `/api/email-subscribers/${sub.id}`, { reportTypes: remaining });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      toast({ title: "Subscriber removed from leader report" });
    },
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

  const formatScheduleTime = (hour: number, minute: number) => {
    const h = hour.toString().padStart(2, '0');
    const m = minute.toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  const handleTimeChange = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      scheduleUpdateMutation.mutate({ reportType: 'leader_report', sendHour: h, sendMinute: m });
    }
  };

  const handleToggleSchedule = (checked: boolean) => {
    scheduleUpdateMutation.mutate({ reportType: 'leader_report', isEnabled: checked });
  };

  return (
    <Collapsible data-testid="collapsible-leader-report">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-leader-report">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Star className="h-5 w-5" />
                Leader Rankings Report
              </CardTitle>
              <CardDescription>
                Top 10 company-wide leaders and per-store rankings with overall position.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between gap-4 p-3 border rounded-md" data-testid="schedule-leader-report">
              <div className="flex items-center gap-3 min-w-0">
                <Checkbox
                  checked={leaderSchedule?.isEnabled ?? true}
                  onCheckedChange={(checked) => handleToggleSchedule(checked === true)}
                  data-testid="checkbox-leader-report-enabled"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Automated Sending</p>
                  <p className="text-xs text-muted-foreground">Enable or disable scheduled delivery</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Send at</Label>
                <Input
                  type="time"
                  className="w-28"
                  value={formatScheduleTime(leaderSchedule?.sendHour ?? 6, leaderSchedule?.sendMinute ?? 0)}
                  onChange={(e) => handleTimeChange(e.target.value)}
                  disabled={!(leaderSchedule?.isEnabled ?? true)}
                  data-testid="input-leader-report-time"
                />
                <span className="text-xs text-muted-foreground">CT</span>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium">Subscribers</h4>
              <div className="flex gap-2 flex-wrap">
                <Input
                  type="text"
                  placeholder="Name (optional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-40"
                  data-testid="input-leader-subscriber-name"
                />
                <Input
                  type="email"
                  placeholder="Email address"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="flex-1 min-w-[200px]"
                  data-testid="input-leader-subscriber-email"
                />
                <Button
                  onClick={() => addMutation.mutate()}
                  disabled={!newEmail.trim() || addMutation.isPending}
                  data-testid="button-add-leader-subscriber"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>

              {subscribersLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Loading subscribers...</div>
              ) : leaderSubscribers.length > 0 ? (
                <div className="space-y-2">
                  {leaderSubscribers.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center gap-3 p-3 rounded-md border"
                      data-testid={`row-leader-subscriber-${sub.id}`}
                    >
                      <Checkbox
                        checked={sub.isActive}
                        onCheckedChange={(checked) => {
                          toggleMutation.mutate({ id: sub.id, isActive: !!checked });
                        }}
                        data-testid={`checkbox-leader-subscriber-active-${sub.id}`}
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
                        onClick={() => removeMutation.mutate(sub)}
                        disabled={removeMutation.isPending}
                        data-testid={`button-remove-leader-subscriber-${sub.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <Star className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No subscribers yet.</p>
                  <p className="text-sm">Add email addresses to receive leader ranking reports.</p>
                </div>
              )}
            </div>

            <div className="flex gap-2 flex-wrap pt-2 border-t">
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
                disabled={sendNowMutation.isPending || leaderSubscribers.length === 0}
                data-testid="button-send-leader-report-now"
              >
                <Send className="h-4 w-4 mr-1" />
                {sendNowMutation.isPending ? "Sending..." : "Send Now"}
              </Button>
            </div>

            {showPreview && (
              <div className="mt-4">
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
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function PushReportCard() {
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");

  const { data: subscribers, isLoading: subscribersLoading } = useQuery<EmailSubscriber[]>({
    queryKey: ["/api/email-subscribers"],
  });

  const { data: schedules } = useQuery<ReportSchedule[]>({
    queryKey: ["/api/report-schedules"],
  });

  const pushSchedule = schedules?.find(s => s.reportType === 'push_report');
  const pushSubscribers = (subscribers || []).filter(s => s.reportTypes?.includes('push_report'));

  const scheduleUpdateMutation = useMutation({
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

  const addMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/email-subscribers", {
        email: newEmail.trim(),
        name: newName.trim() || null,
        reportTypes: ['push_report'],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      setNewEmail("");
      setNewName("");
      toast({ title: "Subscriber added", description: "Push reports will be sent to this email." });
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
    mutationFn: async (sub: EmailSubscriber) => {
      const remaining = (sub.reportTypes || []).filter(t => t !== 'push_report');
      if (remaining.length === 0) {
        return apiRequest("DELETE", `/api/email-subscribers/${sub.id}`);
      }
      return apiRequest("PATCH", `/api/email-subscribers/${sub.id}`, { reportTypes: remaining });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      toast({ title: "Subscriber removed from push report" });
    },
  });

  const sendNowMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/push-report/send-now");
    },
    onSuccess: async (response) => {
      const data = await response.json();
      toast({
        title: "Push reports sent",
        description: `${data.sent} email(s) sent, ${data.failed} failed.`,
      });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error?.message || "Failed to send push reports", variant: "destructive" });
    },
  });

  const formatScheduleTime = (hour: number, minute: number) => {
    const h = hour.toString().padStart(2, '0');
    const m = minute.toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  const handleTimeChange = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      scheduleUpdateMutation.mutate({ reportType: 'push_report', sendHour: h, sendMinute: m });
    }
  };

  const handleToggleSchedule = (checked: boolean) => {
    scheduleUpdateMutation.mutate({ reportType: 'push_report', isEnabled: checked });
  };

  return (
    <Collapsible>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                Push Report (Per-Unit)
              </CardTitle>
              <CardDescription>
                Individual unit performance reports for the previous day, sent to subscribers. Also available on-demand from the Daily Performance page.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between gap-4 p-3 border rounded-md">
              <div className="flex items-center gap-3 min-w-0">
                <Checkbox
                  checked={pushSchedule?.isEnabled ?? false}
                  onCheckedChange={(checked) => handleToggleSchedule(checked === true)}
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Automated Sending</p>
                  <p className="text-xs text-muted-foreground">Sends individual reports for every unit to all subscribers</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Send at</Label>
                <Input
                  type="time"
                  className="w-28"
                  value={formatScheduleTime(pushSchedule?.sendHour ?? 6, pushSchedule?.sendMinute ?? 30)}
                  onChange={(e) => handleTimeChange(e.target.value)}
                  disabled={!(pushSchedule?.isEnabled ?? false)}
                />
                <span className="text-xs text-muted-foreground">CT</span>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium">Subscribers</h4>
              <div className="flex gap-2 flex-wrap">
                <Input
                  type="text"
                  placeholder="Name (optional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-40"
                />
                <Input
                  type="email"
                  placeholder="Email address"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="flex-1 min-w-[200px]"
                />
                <Button
                  onClick={() => addMutation.mutate()}
                  disabled={!newEmail.trim() || addMutation.isPending}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>

              {subscribersLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Loading subscribers...</div>
              ) : pushSubscribers.length > 0 ? (
                <div className="space-y-2">
                  {pushSubscribers.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center gap-3 p-3 rounded-md border"
                    >
                      <Checkbox
                        checked={sub.isActive}
                        onCheckedChange={(checked) => {
                          toggleMutation.mutate({ id: sub.id, isActive: !!checked });
                        }}
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
                        onClick={() => removeMutation.mutate(sub)}
                        disabled={removeMutation.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <Send className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No subscribers yet.</p>
                  <p className="text-sm">Add email addresses to receive per-unit push reports.</p>
                </div>
              )}
            </div>

            <div className="flex gap-2 flex-wrap pt-2 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={() => sendNowMutation.mutate()}
                disabled={sendNowMutation.isPending || pushSubscribers.length === 0}
              >
                <Send className="h-4 w-4 mr-1" />
                {sendNowMutation.isPending ? "Sending..." : "Send All Unit Reports Now"}
              </Button>
            </div>

            <div className="p-3 rounded-md bg-muted/50">
              <p className="text-xs text-muted-foreground">
                Push reports can also be generated on-demand for individual units from the Daily Performance page.
                Expand any unit card and click the "Report" button to preview, print/save as PDF, or share via link.
              </p>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function SalesSummaryReportCard() {
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const { data: subscribers, isLoading: subscribersLoading } = useQuery<EmailSubscriber[]>({
    queryKey: ["/api/email-subscribers"],
  });

  const { data: schedules } = useQuery<ReportSchedule[]>({
    queryKey: ["/api/report-schedules"],
  });

  const summarySchedule = schedules?.find(s => s.reportType === 'sales_summary');
  const summarySubscribers = (subscribers || []).filter(s => s.reportTypes?.includes('sales_summary'));

  const scheduleUpdateMutation = useMutation({
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

  const addMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/email-subscribers", {
        email: newEmail.trim(),
        name: newName.trim() || null,
        reportTypes: ['sales_summary'],
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      setNewEmail("");
      setNewName("");
      toast({ title: "Subscriber added", description: "Sales summary reports will be sent to this email." });
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
    mutationFn: async (sub: EmailSubscriber) => {
      const remaining = (sub.reportTypes || []).filter(t => t !== 'sales_summary');
      if (remaining.length === 0) {
        return apiRequest("DELETE", `/api/email-subscribers/${sub.id}`);
      }
      return apiRequest("PATCH", `/api/email-subscribers/${sub.id}`, { reportTypes: remaining });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/email-subscribers"] });
      toast({ title: "Subscriber removed from sales summary report" });
    },
  });

  const sendNowMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/sales-summary/send-now");
    },
    onSuccess: async (response) => {
      const data = await response.json();
      toast({
        title: "Sales summary sent",
        description: `${data.sent} email(s) sent, ${data.failed} failed.`,
      });
    },
    onError: (error: any) => {
      toast({ title: "Error", description: error?.message || "Failed to send sales summary", variant: "destructive" });
    },
  });

  const loadPreview = async () => {
    setPreviewLoading(true);
    try {
      const res = await fetch("/api/sales-summary/preview", { credentials: "include" });
      if (!res.ok) {
        let errorMsg = "No data for yesterday";
        try {
          const err = await res.json();
          errorMsg = err.error || err.message || errorMsg;
        } catch { /* response may not be JSON */ }
        toast({ title: "No preview available", description: errorMsg, variant: "destructive" });
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

  const formatScheduleTime = (hour: number, minute: number) => {
    const h = hour.toString().padStart(2, '0');
    const m = minute.toString().padStart(2, '0');
    return `${h}:${m}`;
  };

  const handleTimeChange = (timeStr: string) => {
    const [h, m] = timeStr.split(':').map(Number);
    if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      scheduleUpdateMutation.mutate({ reportType: 'sales_summary', sendHour: h, sendMinute: m });
    }
  };

  const handleToggleSchedule = (checked: boolean) => {
    scheduleUpdateMutation.mutate({ reportType: 'sales_summary', isEnabled: checked });
  };

  return (
    <Collapsible data-testid="collapsible-sales-summary">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-sales-summary">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Sales Summary Report
              </CardTitle>
              <CardDescription>
                Company-wide sales summary for the previous day with per-unit breakdown, YoY comparisons, and market totals.
              </CardDescription>
            </div>
            <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between gap-4 p-3 border rounded-md" data-testid="schedule-sales-summary">
              <div className="flex items-center gap-3 min-w-0">
                <Checkbox
                  checked={summarySchedule?.isEnabled ?? false}
                  onCheckedChange={(checked) => handleToggleSchedule(checked === true)}
                  data-testid="checkbox-sales-summary-enabled"
                />
                <div className="min-w-0">
                  <p className="text-sm font-medium">Automated Sending</p>
                  <p className="text-xs text-muted-foreground">Enable or disable scheduled delivery</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">Send at</Label>
                <Input
                  type="time"
                  className="w-28"
                  value={formatScheduleTime(summarySchedule?.sendHour ?? 6, summarySchedule?.sendMinute ?? 0)}
                  onChange={(e) => handleTimeChange(e.target.value)}
                  disabled={!(summarySchedule?.isEnabled ?? false)}
                  data-testid="input-sales-summary-time"
                />
                <span className="text-xs text-muted-foreground">CT</span>
              </div>
            </div>

            <div className="space-y-4">
              <h4 className="text-sm font-medium">Subscribers</h4>
              <div className="flex gap-2 flex-wrap">
                <Input
                  type="text"
                  placeholder="Name (optional)"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-40"
                  data-testid="input-sales-summary-subscriber-name"
                />
                <Input
                  type="email"
                  placeholder="Email address"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="flex-1 min-w-[200px]"
                  data-testid="input-sales-summary-subscriber-email"
                />
                <Button
                  onClick={() => addMutation.mutate()}
                  disabled={!newEmail.trim() || addMutation.isPending}
                  data-testid="button-add-sales-summary-subscriber"
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add
                </Button>
              </div>

              {subscribersLoading ? (
                <div className="text-center py-4 text-muted-foreground text-sm">Loading subscribers...</div>
              ) : summarySubscribers.length > 0 ? (
                <div className="space-y-2">
                  {summarySubscribers.map((sub) => (
                    <div
                      key={sub.id}
                      className="flex items-center gap-3 p-3 rounded-md border"
                      data-testid={`row-sales-summary-subscriber-${sub.id}`}
                    >
                      <Checkbox
                        checked={sub.isActive}
                        onCheckedChange={(checked) => {
                          toggleMutation.mutate({ id: sub.id, isActive: !!checked });
                        }}
                        data-testid={`checkbox-sales-summary-subscriber-active-${sub.id}`}
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
                        onClick={() => removeMutation.mutate(sub)}
                        disabled={removeMutation.isPending}
                        data-testid={`button-remove-sales-summary-subscriber-${sub.id}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-6 text-muted-foreground">
                  <BarChart3 className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No subscribers yet.</p>
                  <p className="text-sm">Add email addresses to receive sales summary reports.</p>
                </div>
              )}
            </div>

            <div className="flex gap-2 flex-wrap pt-2 border-t">
              <Button
                variant="outline"
                size="sm"
                onClick={loadPreview}
                disabled={previewLoading}
                data-testid="button-preview-sales-summary"
              >
                <Eye className="h-4 w-4 mr-1" />
                {previewLoading ? "Loading..." : "Preview"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => sendNowMutation.mutate()}
                disabled={sendNowMutation.isPending || summarySubscribers.length === 0}
                data-testid="button-send-sales-summary-now"
              >
                <Send className="h-4 w-4 mr-1" />
                {sendNowMutation.isPending ? "Sending..." : "Send Now"}
              </Button>
            </div>

            {showPreview && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Report Preview (Yesterday)</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => { setShowPreview(false); setPreviewHtml(null); }}
                    data-testid="button-close-sales-summary-preview"
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
                      title="Sales Summary Report Preview"
                      data-testid="iframe-sales-summary-preview"
                    />
                  </div>
                ) : (
                  <div className="text-center py-8 text-muted-foreground border rounded-md">
                    <BarChart3 className="h-8 w-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">No report data available for yesterday.</p>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function SalesPlanUploadCard() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [sourceLabel, setSourceLabel] = useState("");
  const [uploadResult, setUploadResult] = useState<{
    inserted: number;
    skipped: number;
    totalRows: number;
    sheetsProcessed: Array<{ sheet: string; unitNumber: string; rows: number }>;
    unmatchedStores: string[];
  } | null>(null);

  const { data: summary } = useQuery<{
    totalRecords: number;
    minDate: string | null;
    maxDate: string | null;
    storeCount: number;
    sources: string[];
  }>({
    queryKey: ["/api/sales-plan/summary"],
  });

  const { data: coverage } = useQuery<{
    quarterStart: string;
    throughDate: string;
    missing: Array<{
      restaurantId: string;
      name: string;
      unitNumber: string | null;
      missingCount: number;
      firstMissing: string | null;
      lastMissing: string | null;
      totalExpected: number;
    }>;
  }>({
    queryKey: ["/api/sales-plan/coverage"],
  });

  const deleteMutation = useMutation({
    mutationFn: async () => apiRequest("DELETE", "/api/sales-plan"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sales-plan/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-plan/coverage"] });
      setUploadResult(null);
      toast({ title: "Sales plan cleared", description: "All sales plan data has been deleted." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete sales plan data.", variant: "destructive" });
    },
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith(".xlsx") && !lower.endsWith(".xls")) {
      toast({ title: "Invalid file", description: "Please upload an .xlsx file.", variant: "destructive" });
      return;
    }

    setUploading(true);
    setUploadResult(null);
    try {
      const buf = await file.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
      }
      const fileBase64 = btoa(binary);

      const response = await apiRequest("POST", "/api/sales-plan/upload", {
        fileBase64,
        fileName: file.name,
        sourceLabel: sourceLabel.trim() || undefined,
      });
      const result = await response.json();
      setUploadResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/sales-plan/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-plan/coverage"] });
      toast({
        title: "Upload complete",
        description: `${result.inserted} plan records imported across ${result.sheetsProcessed?.length ?? 0} units.`,
      });
    } catch (error: any) {
      toast({
        title: "Upload failed",
        description: error?.message || "Failed to upload sales plan file.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "N/A";
    try { return format(parseISO(dateStr), "MMM d, yyyy"); } catch { return dateStr; }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0" data-testid="trigger-sales-plan">
            <div>
              <CardTitle className="flex items-center gap-2">
                <BarChart3 className="h-5 w-5" />
                Sales Plan (Forecast)
              </CardTitle>
              <CardDescription className="mt-1">
                Upload a daily sales plan workbook (.xlsx). One sheet per unit, columns: location_code, business_date, net_sales, paper_cost_pct, variable_labor_pct.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {coverage && coverage.missing.length > 0 && (
                <Badge variant="destructive" data-testid="badge-sales-plan-missing">
                  <AlertCircle className="h-3 w-3 mr-1" />
                  {coverage.missing.length} {coverage.missing.length === 1 ? "unit" : "units"} missing days
                </Badge>
              )}
              {summary && summary.totalRecords > 0 && (
                <Badge variant="secondary" data-testid="badge-sales-plan-count">
                  {summary.totalRecords.toLocaleString()} records
                </Badge>
              )}
              <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            <div className="space-y-4">
              {coverage && coverage.missing.length > 0 && (
                <div
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-2"
                  data-testid="banner-sales-plan-coverage"
                >
                  <div className="flex items-start gap-2">
                    <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">
                        {coverage.missing.length} {coverage.missing.length === 1 ? "unit is" : "units are"} missing plan rows for the current quarter
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Quarter window: {formatDate(coverage.quarterStart)} – {formatDate(coverage.throughDate)}.
                        Upload an updated sheet below to fill the gaps.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        document.querySelector('[data-testid="label-sales-plan-upload"]')?.scrollIntoView({ behavior: "smooth", block: "center" });
                      }}
                      data-testid="button-sales-plan-coverage-jump"
                    >
                      Go to upload
                    </Button>
                  </div>
                  <div className="max-h-48 overflow-y-auto rounded border border-border/50 bg-background/40">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/40">
                        <tr>
                          <th className="text-left px-2 py-1 font-medium">Unit</th>
                          <th className="text-right px-2 py-1 font-medium">Missing days</th>
                          <th className="text-left px-2 py-1 font-medium">First gap</th>
                          <th className="text-left px-2 py-1 font-medium">Last gap</th>
                        </tr>
                      </thead>
                      <tbody>
                        {coverage.missing.map(m => (
                          <tr
                            key={m.restaurantId}
                            className="border-t border-border/40"
                            data-testid={`row-coverage-missing-${m.restaurantId}`}
                          >
                            <td className="px-2 py-1">
                              {m.unitNumber ? <span className="font-mono">{m.unitNumber}</span> : null}
                              {m.unitNumber ? " · " : ""}
                              {m.name}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums">
                              {m.missingCount} / {m.totalExpected}
                            </td>
                            <td className="px-2 py-1">{m.firstMissing ? formatDate(m.firstMissing) : "—"}</td>
                            <td className="px-2 py-1">{m.lastMissing ? formatDate(m.lastMissing) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {summary && summary.totalRecords > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-2xl font-bold" data-testid="text-sales-plan-records">{summary.totalRecords.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground">Records</div>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-2xl font-bold" data-testid="text-sales-plan-stores">{summary.storeCount}</div>
                    <div className="text-xs text-muted-foreground">Units</div>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-sm font-semibold" data-testid="text-sales-plan-from">{formatDate(summary.minDate)}</div>
                    <div className="text-xs text-muted-foreground">From</div>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-sm font-semibold" data-testid="text-sales-plan-to">{formatDate(summary.maxDate)}</div>
                    <div className="text-xs text-muted-foreground">To</div>
                  </div>
                </div>
              )}

              {summary && summary.sources && summary.sources.length > 0 && (
                <div className="text-xs text-muted-foreground">
                  Sources loaded: {summary.sources.join(", ")}
                </div>
              )}

              <div className="grid sm:grid-cols-[1fr_auto] gap-3 items-end">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground" htmlFor="sales-plan-label">
                    Source label (optional, e.g. "Q3 2026")
                  </label>
                  <Input
                    id="sales-plan-label"
                    value={sourceLabel}
                    onChange={(e) => setSourceLabel(e.target.value)}
                    placeholder="Q3 2026"
                    disabled={uploading}
                    data-testid="input-sales-plan-label"
                  />
                </div>
                <label className="cursor-pointer" data-testid="label-sales-plan-upload">
                  <input
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    onChange={handleFileUpload}
                    disabled={uploading}
                    data-testid="input-sales-plan-upload"
                  />
                  <Button asChild disabled={uploading} data-testid="button-upload-sales-plan">
                    <span>
                      {uploading ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <FileUp className="h-4 w-4 mr-2" />
                      )}
                      {uploading ? "Uploading..." : "Upload Plan"}
                    </span>
                  </Button>
                </label>
              </div>

              {summary && summary.totalRecords > 0 && (
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirm("Delete all sales plan data? This cannot be undone.")) {
                        deleteMutation.mutate();
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    data-testid="button-delete-sales-plan"
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Clear All Plan Data
                  </Button>
                </div>
              )}

              {uploadResult && (
                <div className="p-3 rounded-lg border bg-muted/30 space-y-2" data-testid="div-sales-plan-upload-result">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span className="text-sm font-medium">Upload Results</span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {uploadResult.inserted} records imported from {uploadResult.totalRows} total rows
                    {uploadResult.skipped > 0 && ` (${uploadResult.skipped} skipped)`}
                    {uploadResult.sheetsProcessed?.length ? ` across ${uploadResult.sheetsProcessed.length} sheets` : ""}
                  </div>
                  {uploadResult.unmatchedStores.length > 0 && (
                    <div className="text-sm">
                      <span className="text-amber-500 font-medium">Unmatched units:</span>{" "}
                      <span className="text-muted-foreground">{uploadResult.unmatchedStores.join(", ")}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="text-xs text-muted-foreground space-y-1">
                <p>Each sheet name should be the unit number (e.g. <code className="bg-muted px-1 rounded">1237</code>).</p>
                <p>Columns expected: <code className="bg-muted px-1 rounded">location_code, business_date, gross_sales, comps_discounts, net_sales, paper_cost_pct, variable_labor_pct</code></p>
                <p>Dates may be Excel serial numbers, ISO (YYYY-MM-DD), or M/D/YYYY. Existing dates are overwritten by the latest upload.</p>
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function HistoricalSalesUploadCard() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<{
    inserted: number;
    skipped: number;
    totalRows: number;
    unmatchedStores: string[];
  } | null>(null);

  const { data: summary, isLoading: summaryLoading } = useQuery<{
    totalRecords: number;
    minDate: string | null;
    maxDate: string | null;
    storeCount: number;
  }>({
    queryKey: ["/api/historical-sales/summary"],
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("DELETE", "/api/historical-sales");
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/historical-sales/summary"] });
      setUploadResult(null);
      toast({ title: "Historical data cleared", description: "All historical sales data has been deleted." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to delete historical data.", variant: "destructive" });
    },
  });

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith(".csv")) {
      toast({ title: "Invalid file", description: "Please upload a CSV file.", variant: "destructive" });
      return;
    }

    setUploading(true);
    setUploadResult(null);

    try {
      const text = await file.text();
      const response = await apiRequest("POST", "/api/historical-sales/upload", { csvData: text });
      const result = await response.json();
      setUploadResult(result);
      queryClient.invalidateQueries({ queryKey: ["/api/historical-sales/summary"] });
      toast({
        title: "Upload complete",
        description: `${result.inserted} records imported, ${result.skipped} skipped.`,
      });
    } catch (error: any) {
      toast({
        title: "Upload failed",
        description: error.message || "Failed to upload CSV file.",
        variant: "destructive",
      });
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return "N/A";
    try {
      return format(parseISO(dateStr), "MMM d, yyyy");
    } catch {
      return dateStr;
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0" data-testid="trigger-historical-sales">
            <div>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                Historical Sales Data (YoY)
              </CardTitle>
              <CardDescription className="mt-1">
                Upload daily sales CSV for year-over-year comparisons. Format: Location, Date, Net Sales, Guest Count
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {summary && summary.totalRecords > 0 && (
                <Badge variant="secondary" data-testid="badge-historical-count">
                  {summary.totalRecords.toLocaleString()} records
                </Badge>
              )}
              <ChevronDown className={`h-5 w-5 text-muted-foreground transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            <div className="space-y-4">
              {summary && summary.totalRecords > 0 && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-2xl font-bold" data-testid="text-historical-records">{summary.totalRecords.toLocaleString()}</div>
                    <div className="text-xs text-muted-foreground">Records</div>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-2xl font-bold" data-testid="text-historical-stores">{summary.storeCount}</div>
                    <div className="text-xs text-muted-foreground">Stores</div>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-sm font-semibold" data-testid="text-historical-from">{formatDate(summary.minDate)}</div>
                    <div className="text-xs text-muted-foreground">From</div>
                  </div>
                  <div className="text-center p-3 rounded-lg border">
                    <div className="text-sm font-semibold" data-testid="text-historical-to">{formatDate(summary.maxDate)}</div>
                    <div className="text-xs text-muted-foreground">To</div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-3 flex-wrap">
                <label className="cursor-pointer" data-testid="label-csv-upload">
                  <input
                    type="file"
                    accept=".csv"
                    className="hidden"
                    onChange={handleFileUpload}
                    disabled={uploading}
                    data-testid="input-csv-upload"
                  />
                  <Button asChild disabled={uploading} data-testid="button-upload-csv">
                    <span>
                      {uploading ? (
                        <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <FileUp className="h-4 w-4 mr-2" />
                      )}
                      {uploading ? "Uploading..." : "Upload CSV"}
                    </span>
                  </Button>
                </label>

                {summary && summary.totalRecords > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (confirm("Delete all historical sales data? This cannot be undone.")) {
                        deleteMutation.mutate();
                      }
                    }}
                    disabled={deleteMutation.isPending}
                    data-testid="button-delete-historical"
                  >
                    <Trash2 className="h-4 w-4 mr-1" />
                    Clear All Data
                  </Button>
                )}
              </div>

              {uploadResult && (
                <div className="p-3 rounded-lg border bg-muted/30 space-y-2" data-testid="div-upload-result">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="h-4 w-4 text-green-500" />
                    <span className="text-sm font-medium">Upload Results</span>
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {uploadResult.inserted} records imported from {uploadResult.totalRows} total rows
                    {uploadResult.skipped > 0 && ` (${uploadResult.skipped} skipped)`}
                  </div>
                  {uploadResult.unmatchedStores.length > 0 && (
                    <div className="text-sm">
                      <span className="text-amber-500 font-medium">Unmatched stores:</span>{" "}
                      <span className="text-muted-foreground">{uploadResult.unmatchedStores.join(", ")}</span>
                    </div>
                  )}
                </div>
              )}

              <div className="text-xs text-muted-foreground space-y-1">
                <p>Expected CSV format: <code className="bg-muted px-1 rounded">Location,Date,Net Sales,Guest Count</code></p>
                <p>Location format: <code className="bg-muted px-1 rounded">1237 - Athens</code> (unit number must match)</p>
                <p>Date format: <code className="bg-muted px-1 rounded">M/D/YY</code> (e.g., 2/12/26)</p>
                <p>Duplicate dates are automatically updated with the latest upload.</p>
              </div>
            </div>
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

// ─── Ticker Messages Admin ──────────────────────────────────────────────────

function TickerMessagesCard() {
  const { toast } = useToast();
  const [newMessage, setNewMessage] = useState("");
  const [newPriority, setNewPriority] = useState("normal");
  const [newType, setNewType] = useState("immediate");
  const [scheduledAt, setScheduledAt] = useState("");
  const [expiresIn, setExpiresIn] = useState("4"); // hours

  const { data, refetch } = useQuery<{ messages: TickerMessage[] }>({
    queryKey: ["/api/ticker/admin/messages"],
  });

  const createMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      return apiRequest("POST", "/api/ticker/messages", body);
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/ticker/messages"] });
      setNewMessage("");
      setScheduledAt("");
      toast({ title: "Message sent", description: "Ticker message has been created." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create message.", variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return apiRequest("PATCH", `/api/ticker/messages/${id}`, { isActive });
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/ticker/messages"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/ticker/messages/${id}`);
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/ticker/messages"] });
      toast({ title: "Deleted", description: "Message removed." });
    },
  });

  const handleCreate = () => {
    if (!newMessage.trim()) return;

    const body: Record<string, unknown> = {
      message: newMessage.trim(),
      priority: newPriority,
      type: newType,
    };

    if (newType === "scheduled" && scheduledAt) {
      body.scheduledAt = new Date(scheduledAt).toISOString();
    }

    if (expiresIn && Number(expiresIn) > 0) {
      body.expiresAt = new Date(Date.now() + Number(expiresIn) * 60 * 60 * 1000).toISOString();
    }

    createMutation.mutate(body);
  };

  const messages = data?.messages || [];

  return (
    <CollapsibleCard
      title="Banner Ticker"
      description="Send real-time messages that scroll across the dashboard banner."
      icon={<Megaphone className="h-5 w-5 text-primary" />}
    >
      <div className="space-y-4">
        {/* New message form */}
        <div className="space-y-3 p-4 bg-secondary/30 rounded-lg border border-border">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Plus className="w-4 h-4" />
            New Message
          </div>

          <Textarea
            placeholder="Great job 1679 - you set the new hourly record for the week!"
            value={newMessage}
            onChange={(e) => setNewMessage(e.target.value)}
            className="min-h-[60px]"
          />

          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={newType} onValueChange={setNewType}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="immediate">Immediate</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label className="text-xs">Priority</Label>
              <Select value={newPriority} onValueChange={setNewPriority}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {newType === "scheduled" && (
              <div>
                <Label className="text-xs">Send At</Label>
                <Input
                  type="datetime-local"
                  value={scheduledAt}
                  onChange={(e) => setScheduledAt(e.target.value)}
                  className="h-8 text-xs"
                />
              </div>
            )}

            <div>
              <Label className="text-xs">Expires In (hrs)</Label>
              <Input
                type="number"
                min="1"
                max="72"
                value={expiresIn}
                onChange={(e) => setExpiresIn(e.target.value)}
                className="h-8 text-xs"
                placeholder="4"
              />
            </div>
          </div>

          <Button
            onClick={handleCreate}
            disabled={!newMessage.trim() || createMutation.isPending}
            size="sm"
            className="w-full"
          >
            <Send className="w-3.5 h-3.5 mr-2" />
            {createMutation.isPending ? "Sending..." : "Send Message"}
          </Button>
        </div>

        {/* Existing messages */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-muted-foreground">Recent Messages ({messages.length})</h4>
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">No ticker messages yet</p>
          )}
          {messages.map(msg => (
            <div
              key={msg.id}
              className={`flex items-start gap-3 p-3 rounded-lg border ${
                msg.isActive ? "bg-card" : "bg-muted/30 opacity-60"
              }`}
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm">{msg.message}</p>
                <div className="flex items-center gap-2 mt-1">
                  <Badge variant="outline" className="text-[10px] h-5">
                    {msg.type}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={`text-[10px] h-5 ${
                      msg.priority === "urgent"
                        ? "border-red-500/50 text-red-500"
                        : msg.priority === "high"
                        ? "border-amber-500/50 text-amber-500"
                        : ""
                    }`}
                  >
                    {msg.priority}
                  </Badge>
                  {msg.expiresAt && (
                    <span className="text-[10px] text-muted-foreground">
                      expires {new Date(msg.expiresAt).toLocaleString()}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Switch
                  checked={msg.isActive}
                  onCheckedChange={(checked) => toggleMutation.mutate({ id: msg.id, isActive: checked })}
                />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                  onClick={() => deleteMutation.mutate(msg.id)}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </CollapsibleCard>
  );
}

// ─── Milestone Config Admin ─────────────────────────────────────────────────

function MilestoneConfigCard() {
  const { toast } = useToast();

  const { data, refetch } = useQuery<{ config: {
    id: string | null;
    isEnabled: boolean;
    milestoneTypes: Record<string, boolean>;
  } }>({
    queryKey: ["/api/ticker/milestone-config"],
  });

  const updateMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      return apiRequest("PUT", "/api/ticker/milestone-config", body);
    },
    onSuccess: () => {
      refetch();
      toast({ title: "Milestone config updated" });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to update config.", variant: "destructive" });
    },
  });

  const checkMutation = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/ticker/check-milestones", {});
    },
    onSuccess: async (res) => {
      const data = await res.json();
      refetch();
      toast({
        title: "Milestones checked",
        description: `Found ${data.count || 0} new milestones.`,
      });
    },
  });

  const config = data?.config;
  const types = config?.milestoneTypes || {};

  const milestoneLabels: Record<string, string> = {
    hourlyRecord: "Hourly Sales Records",
    dailySalesRecord: "Daily Sales Records",
    fastestDriveThru: "Fastest Drive-Thru",
    topCheckAverage: "Top Check Average",
    paceLeader: "Pace Race Leader",
    hourlyRateBadge: "Hourly Rate Badges ($750+ Contender → $2300+ Legendary)",
  };

  return (
    <CollapsibleCard
      title="Auto-Milestones"
      description="Automatically detect and announce performance milestones."
      icon={<Zap className="h-5 w-5 text-amber-500" />}
      actions={
        config && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {config.isEnabled ? "On" : "Off"}
            </span>
            <Switch
              checked={config.isEnabled}
              onCheckedChange={(checked) => updateMutation.mutate({ isEnabled: checked })}
            />
          </div>
        )
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          When enabled, the system automatically detects milestones throughout the day and sends them as ticker messages.
        </p>

        <div className="space-y-2">
          {Object.entries(milestoneLabels).map(([key, label]) => (
            <div key={key} className="flex items-center justify-between py-1.5 border-b border-border last:border-0">
              <span className="text-sm">{label}</span>
              <Switch
                checked={types[key] ?? true}
                onCheckedChange={(checked) => {
                  const newTypes = { ...types, [key]: checked };
                  updateMutation.mutate({ milestoneTypes: newTypes });
                }}
                disabled={!config?.isEnabled}
              />
            </div>
          ))}
        </div>

        <Button
          variant="outline"
          size="sm"
          onClick={() => checkMutation.mutate()}
          disabled={!config?.isEnabled || checkMutation.isPending}
          className="w-full"
        >
          <RefreshCw className={`w-3.5 h-3.5 mr-2 ${checkMutation.isPending ? "animate-spin" : ""}`} />
          {checkMutation.isPending ? "Checking..." : "Check Milestones Now"}
        </Button>
      </div>
    </CollapsibleCard>
  );
}

// ─── Poll Management Admin ──────────────────────────────────────────────────

function PollManagementCard() {
  const { toast } = useToast();
  const [newQuestion, setNewQuestion] = useState("");
  const [newOptions, setNewOptions] = useState(["", ""]);
  const [newExpiresIn, setNewExpiresIn] = useState("24");

  const { data, refetch } = useQuery<{ polls: PollWithResults[] }>({
    queryKey: ["/api/polls/admin"],
  });

  const createMutation = useMutation({
    mutationFn: async (body: Record<string, unknown>) => {
      return apiRequest("POST", "/api/polls", body);
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/polls/active"] });
      setNewQuestion("");
      setNewOptions(["", ""]);
      toast({ title: "Poll created", description: "Your poll is now live." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to create poll.", variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return apiRequest("PATCH", `/api/polls/${id}`, { isActive });
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/polls/active"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      return apiRequest("DELETE", `/api/polls/${id}`);
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["/api/polls/active"] });
      toast({ title: "Deleted", description: "Poll removed." });
    },
  });

  const handleCreate = () => {
    const filteredOptions = newOptions.filter(o => o.trim().length > 0);
    if (!newQuestion.trim() || filteredOptions.length < 2) {
      toast({ title: "Error", description: "Question and at least 2 options required.", variant: "destructive" });
      return;
    }

    const body: Record<string, unknown> = {
      question: newQuestion.trim(),
      options: filteredOptions,
    };

    if (newExpiresIn && Number(newExpiresIn) > 0) {
      body.expiresAt = new Date(Date.now() + Number(newExpiresIn) * 60 * 60 * 1000).toISOString();
    }

    createMutation.mutate(body);
  };

  const addOption = () => {
    if (newOptions.length < 10) {
      setNewOptions([...newOptions, ""]);
    }
  };

  const removeOption = (idx: number) => {
    if (newOptions.length > 2) {
      setNewOptions(newOptions.filter((_, i) => i !== idx));
    }
  };

  const updateOption = (idx: number, value: string) => {
    const updated = [...newOptions];
    updated[idx] = value;
    setNewOptions(updated);
  };

  const existingPolls = data?.polls || [];

  return (
    <CollapsibleCard
      title="Polls"
      description="Create polls for users to vote on - displayed on the dashboard."
      icon={<BarChart3 className="h-5 w-5 text-primary" />}
    >
      <div className="space-y-4">
        {/* New poll form */}
        <div className="space-y-3 p-4 bg-secondary/30 rounded-lg border border-border">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Plus className="w-4 h-4" />
            Create Poll
          </div>

          <div>
            <Label className="text-xs">Question</Label>
            <Input
              placeholder="Who will have the highest check average today?"
              value={newQuestion}
              onChange={(e) => setNewQuestion(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-xs">Options</Label>
            {newOptions.map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <Input
                  placeholder={`Option ${idx + 1}`}
                  value={opt}
                  onChange={(e) => updateOption(idx, e.target.value)}
                  className="h-8 text-sm"
                />
                {newOptions.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                    onClick={() => removeOption(idx)}
                  >
                    <X className="w-3.5 h-3.5" />
                  </Button>
                )}
              </div>
            ))}
            {newOptions.length < 10 && (
              <Button variant="ghost" size="sm" onClick={addOption} className="text-xs">
                <Plus className="w-3 h-3 mr-1" /> Add Option
              </Button>
            )}
          </div>

          <div>
            <Label className="text-xs">Expires In (hours)</Label>
            <Input
              type="number"
              min="1"
              max="168"
              value={newExpiresIn}
              onChange={(e) => setNewExpiresIn(e.target.value)}
              className="h-8 text-xs w-24"
              placeholder="24"
            />
          </div>

          <Button
            onClick={handleCreate}
            disabled={!newQuestion.trim() || newOptions.filter(o => o.trim()).length < 2 || createMutation.isPending}
            size="sm"
            className="w-full"
          >
            <Vote className="w-3.5 h-3.5 mr-2" />
            {createMutation.isPending ? "Creating..." : "Create Poll"}
          </Button>
        </div>

        {/* Existing polls */}
        <div className="space-y-2">
          <h4 className="text-sm font-semibold text-muted-foreground">Polls ({existingPolls.length})</h4>
          {existingPolls.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">No polls yet</p>
          )}
          {existingPolls.map(poll => (
            <div
              key={poll.id}
              className={`p-3 rounded-lg border ${
                poll.isActive ? "bg-card" : "bg-muted/30 opacity-60"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{poll.question}</p>
                  <div className="mt-2 space-y-1">
                    {poll.options.map(opt => (
                      <div key={opt.id} className="flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{opt.label}</span>
                        <span className="font-medium">
                          {opt.voteCount} votes
                          {poll.totalVotes > 0 && (
                            <span className="text-muted-foreground ml-1">
                              ({Math.round((opt.voteCount / poll.totalVotes) * 100)}%)
                            </span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1">
                    {poll.totalVotes} total votes
                    {poll.expiresAt && ` · expires ${new Date(poll.expiresAt).toLocaleString()}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={poll.isActive}
                    onCheckedChange={(checked) => toggleMutation.mutate({ id: poll.id, isActive: checked })}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                    onClick={() => deleteMutation.mutate(poll.id)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </CollapsibleCard>
  );
}

interface ManagedUser {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string | null;
}

// ─── Helper Rewards Card ─────────────────────────────────────────────────────

interface HelperReward {
  id: string;
  restaurantId: string;
  date: string;
  points: number;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

function HelperRewardsCard() {
  const { toast } = useToast();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [selectedDate, setSelectedDate] = useState(today);
  const [calendarOpen, setCalendarOpen] = useState(false);

  const { data: restaurants } = useQuery<Restaurant[]>({
    queryKey: ["/api/restaurants"],
  });

  const { data: rewards, isLoading } = useQuery<HelperReward[]>({
    queryKey: ["/api/helper-rewards", selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/helper-rewards?date=${selectedDate}`);
      if (!res.ok) return [];
      return res.json();
    },
  });

  const saveMutation = useMutation({
    mutationFn: async ({ restaurantId, points, note }: { restaurantId: string; points: number; note: string }) => {
      return apiRequest("POST", "/api/helper-rewards", {
        restaurantId,
        date: selectedDate,
        points,
        note: note || null,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/helper-rewards", selectedDate] });
      queryClient.invalidateQueries({ queryKey: ["/api/helper-rewards"] });
      toast({ title: "Helper reward saved", description: "Bonus points updated for this unit." });
    },
    onError: () => {
      toast({ title: "Error", description: "Failed to save helper reward.", variant: "destructive" });
    },
  });

  const activeRestaurants = (restaurants || []).filter(r => {
    if (!r.isActive) return false;
    if (r.name.toLowerCase().includes('training') || r.name.toLowerCase().includes('development')) return false;
    return true;
  });

  const rewardsByRestaurant = new Map<string, HelperReward>();
  (rewards || []).forEach(r => rewardsByRestaurant.set(r.restaurantId, r));

  return (
    <CollapsibleCard
      title="Helper Rewards"
      description="Award bonus points to units for helping another unit. Points are added to the daily execution score with no cap."
      icon={<Award className="h-5 w-5 text-purple-500" />}
    >
      <div className="space-y-4">
        {/* Date Picker */}
        <div className="flex items-center gap-3">
          <Label className="text-sm font-medium">Date:</Label>
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-[200px] justify-start text-left font-normal">
                <CalendarIcon className="mr-2 h-4 w-4" />
                {format(new Date(selectedDate + 'T12:00:00'), 'MMM d, yyyy')}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={new Date(selectedDate + 'T12:00:00')}
                onSelect={(date) => {
                  if (date) {
                    setSelectedDate(format(date, 'yyyy-MM-dd'));
                    setCalendarOpen(false);
                  }
                }}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        </div>

        {/* Unit List */}
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading...</div>
        ) : (
          <div className="space-y-2">
            {activeRestaurants.map(restaurant => {
              const existing = rewardsByRestaurant.get(restaurant.id);
              return (
                <HelperRewardRow
                  key={restaurant.id}
                  restaurantName={restaurant.name}
                  existingPoints={existing?.points || 0}
                  existingNote={existing?.note || ""}
                  onSave={(points, note) => saveMutation.mutate({ restaurantId: restaurant.id, points, note })}
                  isPending={saveMutation.isPending}
                />
              );
            })}
          </div>
        )}
      </div>
    </CollapsibleCard>
  );
}

function HelperRewardRow({ restaurantName, existingPoints, existingNote, onSave, isPending }: {
  restaurantName: string;
  existingPoints: number;
  existingNote: string;
  onSave: (points: number, note: string) => void;
  isPending: boolean;
}) {
  const [points, setPoints] = useState(String(existingPoints || ""));
  const [note, setNote] = useState(existingNote || "");
  const [isEditing, setIsEditing] = useState(false);

  const isDirty = (Number(points) || 0) !== existingPoints || (note || "") !== (existingNote || "");

  const handleSave = () => {
    onSave(Number(points) || 0, note);
    setIsEditing(false);
  };

  if (!isEditing && existingPoints === 0) {
    return (
      <div className="flex items-center justify-between py-2 px-3 rounded-lg border border-transparent hover:border-border hover:bg-muted/30 transition-colors">
        <span className="text-sm">{restaurantName}</span>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setIsEditing(true)}>
          <Plus className="h-3 w-3 mr-1" /> Add Points
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 py-2 px-3 rounded-lg border bg-muted/20">
      <span className="text-sm font-medium min-w-[180px]">{restaurantName}</span>
      <div className="flex items-center gap-2 flex-1">
        <Input
          type="number"
          min={0}
          max={20}
          className="w-20 h-8 text-sm"
          value={points}
          onChange={(e) => { setPoints(e.target.value); setIsEditing(true); }}
          placeholder="0"
        />
        <span className="text-xs text-muted-foreground">pts</span>
        <Input
          className="h-8 text-sm flex-1"
          value={note}
          onChange={(e) => { setNote(e.target.value); setIsEditing(true); }}
          placeholder="Reason (e.g., Helped Unit 1237 during lunch)"
        />
        {isDirty && (
          <Button size="sm" className="h-8" onClick={handleSave} disabled={isPending}>
            <Save className="h-3 w-3 mr-1" /> Save
          </Button>
        )}
        {existingPoints > 0 && !isDirty && (
          <Badge variant="secondary" className="text-xs bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300">
            +{existingPoints} pts
          </Badge>
        )}
      </div>
    </div>
  );
}

// ─── Grading Configuration Card ─────────────────────────────────────────────

function TierEditor({ label, tiers, onChange }: {
  label: string;
  tiers: ScoringTier[] | undefined;
  onChange: (tiers: ScoringTier[]) => void;
}) {
  const safeTiers = tiers ?? [];
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="space-y-1">
        {safeTiers.map((tier, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground w-16">≥</span>
            <Input
              type="number"
              className="w-20 h-8 text-sm"
              value={tier.threshold}
              onChange={(e) => {
                const updated = [...tiers];
                updated[i] = { ...tier, threshold: Number(e.target.value) };
                onChange(updated);
              }}
            />
            <span className="text-xs text-muted-foreground">→</span>
            <Input
              type="number"
              className="w-20 h-8 text-sm"
              value={tier.points}
              onChange={(e) => {
                const updated = [...tiers];
                updated[i] = { ...tier, points: Number(e.target.value) };
                onChange(updated);
              }}
            />
            <span className="text-xs text-muted-foreground">pts</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={() => {
                const updated = tiers.filter((_, idx) => idx !== i);
                onChange(updated);
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={() => {
            const lowestThreshold = tiers.length > 0 ? tiers[tiers.length - 1].threshold - 10 : 0;
            onChange([...tiers, { threshold: lowestThreshold, points: 50 }]);
          }}
        >
          <Plus className="h-3 w-3 mr-1" /> Add Tier
        </Button>
      </div>
    </div>
  );
}

function GradingConfigCard() {
  const { toast } = useToast();
  const [localConfig, setLocalConfig] = useState<GradingConfigData>(DEFAULT_GRADING_CONFIG);
  const [isDirty, setIsDirty] = useState(false);

  const { data: serverConfig } = useQuery<GradingConfigData>({
    queryKey: ["/api/grading-config"],
  });

  // Sync local state from server when server data arrives (and no unsaved edits)
  const activeConfig = isDirty ? localConfig : (serverConfig || localConfig);

  const updateConfig = (patch: Partial<GradingConfigData>) => {
    const updated = { ...activeConfig, ...patch };
    setLocalConfig(updated);
    setIsDirty(true);
  };

  const saveMutation = useMutation({
    mutationFn: async (cfg: GradingConfigData) => {
      const res = await apiRequest("POST", "/api/grading-config/save", cfg);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("Save failed — server returned an unexpected response");
      }
      return await res.json() as GradingConfigData;
    },
    onSuccess: (savedConfig: GradingConfigData) => {
      // Update local state to the saved config
      setLocalConfig(savedConfig);
      setIsDirty(false);
      // Invalidate grading config (scoring guide page, client components)
      queryClient.invalidateQueries({ queryKey: ["/api/grading-config"] });
      // Invalidate server-computed grading data so dashboard/leaderboard refetch with new config
      queryClient.invalidateQueries({ queryKey: ["/api/leaderboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/performance-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/leaders"] });
      toast({ title: "Grading config saved", description: "Scoring weights and thresholds updated. Dashboard will refresh with new settings." });
    },
    onError: (err: Error) => {
      toast({ title: "Error saving config", description: err.message, variant: "destructive" });
    },
  });

  const handleWeightChange = (metric: keyof GradingConfigData["weights"], value: number) => {
    updateConfig({ weights: { ...activeConfig.weights, [metric]: value } });
  };

  const totalWeight = activeConfig.weights.sales + activeConfig.weights.transactions +
    activeConfig.weights.osat + activeConfig.weights.speed + activeConfig.weights.staffing +
    (activeConfig.weights.feedbackSpeed ?? 0);
  const isValid = totalWeight === 100;

  const handleSave = () => {
    if (!isValid) {
      toast({ title: "Invalid weights", description: `Weights must sum to 100 (currently ${totalWeight})`, variant: "destructive" });
      return;
    }
    saveMutation.mutate(activeConfig);
  };

  const handleReset = () => {
    setLocalConfig(DEFAULT_GRADING_CONFIG);
    setIsDirty(true);
  };

  return (
    <CollapsibleCard
      title="Grading Configuration"
      description="Configure execution score weights, point thresholds, and staffing tolerances."
      icon={<Award className="h-5 w-5 text-amber-500" />}
    >
      <div className="space-y-6">
        {/* Metric Weights */}
        <div>
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            Component Weights
            <Badge variant={isValid ? "default" : "destructive"} className="text-xs">
              {totalWeight}%{isValid ? " ✓" : " — must be 100%"}
            </Badge>
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {(["sales", "transactions", "osat", "speed", "staffing", "feedbackSpeed"] as const).map((metric) => {
              const labelMap: Record<string, string> = {
                sales: "Sales",
                transactions: "Transactions",
                osat: "OSAT",
                speed: "Speed (HME)",
                staffing: "Staffing",
                feedbackSpeed: "OSAT Speed",
              };
              return (
                <div key={metric} className="space-y-1">
                  <Label className="text-xs">{labelMap[metric]}</Label>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      className="h-8 text-sm"
                      value={activeConfig.weights[metric] ?? 0}
                      onChange={(e) => handleWeightChange(metric, Number(e.target.value))}
                      data-testid={`input-grading-weight-${metric}`}
                    />
                    <span className="text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Point Thresholds */}
        <div>
          <h3 className="text-sm font-semibold mb-3">Point Thresholds</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <TierEditor
              label="Sales vs. Last Week (%)"
              tiers={activeConfig.salesTiers}
              onChange={(tiers) => updateConfig({ salesTiers: tiers })}
            />
            <TierEditor
              label="Transactions vs. Last Week (%)"
              tiers={activeConfig.transactionTiers}
              onChange={(tiers) => updateConfig({ transactionTiers: tiers })}
            />
            <TierEditor
              label="OSAT (Guest Satisfaction %)"
              tiers={activeConfig.osatTiers}
              onChange={(tiers) => updateConfig({ osatTiers: tiers })}
            />
            <TierEditor
              label="Drive-Thru Speed (% attainment)"
              tiers={activeConfig.speedTiers}
              onChange={(tiers) => updateConfig({ speedTiers: tiers })}
            />
            <TierEditor
              label="OSAT Speed (% top-box 5★)"
              tiers={activeConfig.feedbackSpeedTiers}
              onChange={(tiers) => updateConfig({ feedbackSpeedTiers: tiers })}
            />
          </div>
        </div>

        {/* Staffing Tolerance */}
        <div>
          <h3 className="text-sm font-semibold mb-3">Staffing vs. Labor Model</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Tolerance (±)</Label>
              <Input
                type="number"
                min={0}
                step={0.5}
                className="h-8 text-sm"
                value={activeConfig.staffingTolerance}
                onChange={(e) => updateConfig({ staffingTolerance: Number(e.target.value) })}
              />
              <p className="text-xs text-muted-foreground">Within ± this many of target = in tolerance</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">In-Tolerance Score</Label>
              <Input
                type="number"
                min={0}
                max={100}
                className="h-8 text-sm"
                value={activeConfig.staffingInToleranceScore}
                onChange={(e) => updateConfig({ staffingInToleranceScore: Number(e.target.value) })}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Out-of-Tolerance Score</Label>
              <Input
                type="number"
                min={0}
                max={100}
                className="h-8 text-sm"
                value={activeConfig.staffingOutToleranceScore}
                onChange={(e) => updateConfig({ staffingOutToleranceScore: Number(e.target.value) })}
              />
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 pt-2 border-t">
          <Button onClick={handleSave} disabled={saveMutation.isPending || !isValid} size="sm">
            <Save className="h-4 w-4 mr-1" />
            {saveMutation.isPending ? "Saving..." : "Save Configuration"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleReset}>
            Reset to Defaults
          </Button>
          {isDirty && (
            <Badge variant="secondary" className="text-xs">Unsaved changes</Badge>
          )}
        </div>
      </div>
    </CollapsibleCard>
  );
}

function UserManagementCard() {
  const { toast } = useToast();

  const { data: authData } = useQuery<{ authenticated: boolean; role?: string; userId?: string; email?: string }>({
    queryKey: ["/api/auth/me"],
  });

  const { data: managedUsers, isLoading } = useQuery<ManagedUser[]>({
    queryKey: ["/api/users"],
    enabled: authData?.role === "admin",
  });

  const statusMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      return apiRequest("PATCH", `/api/users/${id}/status`, { isActive });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "User updated", description: "Access status changed successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err?.message || "Failed to update user.", variant: "destructive" });
    },
  });

  const roleMutation = useMutation({
    mutationFn: async ({ id, role }: { id: string; role: string }) => {
      return apiRequest("PATCH", `/api/users/${id}/role`, { role });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "Role updated", description: "User role changed successfully." });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err?.message || "Failed to update role.", variant: "destructive" });
    },
  });

  if (authData?.role !== "admin") {
    return null;
  }

  const activeUsers = (managedUsers || []).filter(u => u.isActive);
  const inactiveUsers = (managedUsers || []).filter(u => !u.isActive);

  return (
    <Collapsible defaultOpen={false} data-testid="collapsible-user-management">
      <Card>
        <CollapsibleTrigger asChild data-testid="trigger-user-management">
          <CardHeader className="cursor-pointer flex flex-row items-center justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="h-5 w-5" />
                User Management
              </CardTitle>
              <CardDescription className="mt-1">
                Manage user access and roles. Deactivate accounts to immediately revoke access.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {managedUsers && (
                <Badge variant="secondary">{activeUsers.length} active</Badge>
              )}
              <ChevronDown className="h-5 w-5 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent>
            {isLoading ? (
              <div className="text-center py-8 text-muted-foreground">Loading users...</div>
            ) : (
              <div className="space-y-4">
                {activeUsers.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-3">Active Users ({activeUsers.length})</h3>
                    <div className="grid gap-2">
                      {activeUsers.map(user => (
                        <UserRow
                          key={user.id}
                          user={user}
                          onToggleStatus={(isActive) => statusMutation.mutate({ id: user.id, isActive })}
                          onChangeRole={(role) => roleMutation.mutate({ id: user.id, role })}
                          isPending={statusMutation.isPending || roleMutation.isPending}
                          isCurrentUser={user.id === authData?.userId}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {inactiveUsers.length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-muted-foreground mb-3">Deactivated Users ({inactiveUsers.length})</h3>
                    <div className="grid gap-2">
                      {inactiveUsers.map(user => (
                        <UserRow
                          key={user.id}
                          user={user}
                          onToggleStatus={(isActive) => statusMutation.mutate({ id: user.id, isActive })}
                          onChangeRole={(role) => roleMutation.mutate({ id: user.id, role })}
                          isPending={statusMutation.isPending || roleMutation.isPending}
                          isCurrentUser={user.id === authData?.userId}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {(!managedUsers || managedUsers.length === 0) && (
                  <div className="text-center py-4 text-muted-foreground text-sm">No registered users found.</div>
                )}
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function UserRow({ user, onToggleStatus, onChangeRole, isPending, isCurrentUser }: {
  user: ManagedUser;
  onToggleStatus: (isActive: boolean) => void;
  onChangeRole: (role: string) => void;
  isPending: boolean;
  isCurrentUser: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-4 p-3 rounded-lg border ${user.isActive ? 'bg-card' : 'bg-muted/50 opacity-70'}`}
      data-testid={`row-user-${user.id}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{user.email || user.displayName || "Unknown"}</span>
          {user.role === "admin" && (
            <Badge variant="default" className="shrink-0">
              <Shield className="h-3 w-3 mr-1" />
              Admin
            </Badge>
          )}
          {!user.isActive && (
            <Badge variant="secondary" className="shrink-0">
              <ShieldOff className="h-3 w-3 mr-1" />
              Deactivated
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
          {user.lastLoginAt && (
            <span>Last login: {formatDistanceToNow(new Date(user.lastLoginAt), { addSuffix: true })}</span>
          )}
          {user.createdAt && (
            <span>Joined: {format(new Date(user.createdAt), "MMM d, yyyy")}</span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        <Select
          value={user.role}
          onValueChange={(value) => onChangeRole(value)}
          disabled={isPending || isCurrentUser}
        >
          <SelectTrigger className="w-[100px]" data-testid={`select-role-${user.id}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="admin">Admin</SelectItem>
            <SelectItem value="viewer">Viewer</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Switch
            checked={user.isActive}
            onCheckedChange={(checked) => onToggleStatus(checked)}
            disabled={isPending || isCurrentUser}
            data-testid={`switch-active-${user.id}`}
          />
          <span className="text-xs text-muted-foreground w-[28px]">{user.isActive ? "On" : "Off"}</span>
        </div>
      </div>
    </div>
  );
}
