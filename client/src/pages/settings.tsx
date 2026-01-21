import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Settings, CalendarIcon, Save, Home, X } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { format, differenceInDays, isFuture } from "date-fns";
import { Link } from "wouter";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Restaurant } from "@shared/schema";

type RestaurantWithStatus = Restaurant & {
  status: "training" | "new" | "established";
  daysOpen?: number;
};

function getRestaurantStatus(openDate: Date | null | undefined): { status: "training" | "new" | "established"; daysOpen?: number } {
  if (!openDate) return { status: "established" };
  
  const today = new Date();
  if (isFuture(openDate)) {
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

  const startEditing = (restaurant: Restaurant) => {
    setEditingId(restaurant.id);
    setEditDate(restaurant.openDate ? new Date(restaurant.openDate) : undefined);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setEditDate(undefined);
  };

  const restaurantsWithStatus: RestaurantWithStatus[] = (restaurants || []).map(r => ({
    ...r,
    ...getRestaurantStatus(r.openDate ? new Date(r.openDate) : null),
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
}) {
  const openDate = restaurant.openDate ? new Date(restaurant.openDate) : null;

  return (
    <div
      className="flex items-center justify-between gap-4 p-3 rounded-lg border bg-card hover-elevate flex-wrap"
      data-testid={`row-restaurant-${restaurant.id}`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span className="font-medium truncate">{restaurant.name}</span>
        {restaurant.status === "training" && (
          <Badge variant="secondary" className="shrink-0">Training</Badge>
        )}
        {restaurant.status === "new" && (
          <Badge className="bg-blue-500 hover:bg-blue-600 shrink-0">
            NEW UNIT ({restaurant.daysOpen || 0} days)
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {isEditing ? (
          <>
            <Popover>
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
                  onSelect={setEditDate}
                  initialFocus
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
  );
}
