import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { Link } from "wouter";
import { ArrowLeft, Users, ChevronUp, ChevronDown, RefreshCw, CalendarIcon } from "lucide-react";
import { format } from "date-fns";

interface CrewMember {
  name: string;
  tenureMonths: number;
  category: 'trainee' | 'developing' | 'experienced' | 'veteran';
}

interface HourlyCrewData {
  hour: number;
  label: string;
  crewCount: number;
  avgTenure: string;
  score: number;
  mix: string;
  team: CrewMember[];
}

interface RestaurantCrewData {
  restaurantId: string;
  restaurantName: string;
  employeeCount: number;
  avgTenure: string;
  avgScore: number;
  hourly: HourlyCrewData[];
}

interface CrewExperienceResponse {
  date: string;
  restaurants: RestaurantCrewData[];
}

function getCentralDate(): Date {
  const now = new Date();
  const centralStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const [year, month, day] = centralStr.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0);
}

function getScoreColor(score: number): string {
  if (score >= 85) return "bg-green-500";
  if (score >= 70) return "bg-yellow-500";
  if (score >= 50) return "bg-orange-500";
  return "bg-red-500";
}

function getCategoryColor(category: string): string {
  switch (category) {
    case 'trainee': return "bg-red-500";
    case 'developing': return "bg-orange-400";
    case 'experienced': return "bg-green-500";
    case 'veteran': return "bg-blue-500";
    default: return "bg-gray-500";
  }
}

function getCategoryLabel(category: string): string {
  switch (category) {
    case 'trainee': return "T";
    case 'developing': return "D";
    case 'experienced': return "E";
    case 'veteran': return "V";
    default: return "?";
  }
}

export default function CrewExperiencePage() {
  const [selectedDate, setSelectedDate] = useState<Date>(getCentralDate());
  const [expandedRestaurants, setExpandedRestaurants] = useState<Set<string>>(new Set());
  const [isSyncing, setIsSyncing] = useState(false);
  
  const dateStr = format(selectedDate, "yyyy-MM-dd");
  
  const { data, isLoading, refetch } = useQuery<CrewExperienceResponse>({
    queryKey: ["/api/crew/experience", dateStr],
    queryFn: async () => {
      const res = await fetch(`/api/crew/experience?date=${dateStr}`);
      if (!res.ok) throw new Error("Failed to fetch crew data");
      return res.json();
    },
  });
  
  const toggleRestaurant = (id: string) => {
    setExpandedRestaurants(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };
  
  const expandAll = () => {
    if (data) {
      setExpandedRestaurants(new Set(data.restaurants.map(r => r.restaurantId)));
    }
  };
  
  const collapseAll = () => {
    setExpandedRestaurants(new Set());
  };
  
  const handleSync = async () => {
    setIsSyncing(true);
    try {
      await fetch("/api/crew/sync-employees", { method: "POST" });
      await fetch("/api/crew/sync", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: dateStr }),
      });
      await refetch();
    } catch (e) {
      console.error("Sync failed:", e);
    } finally {
      setIsSyncing(false);
    }
  };
  
  const formatDisplayDate = (date: Date) => {
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };
  
  const storesWithData = data?.restaurants.filter(r => r.hourly.length > 0) || [];
  
  return (
    <div className="min-h-screen bg-background p-4">
      <div className="max-w-7xl mx-auto space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-3">
            <Link href="/">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="w-4 h-4" />
              </Button>
            </Link>
            <Users className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">Crew Experience by Hour</h1>
            <Badge variant="outline">{storesWithData.length} stores</Badge>
          </div>
          
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm" data-testid="button-date-picker">
                  <CalendarIcon className="w-4 h-4 mr-2" />
                  {formatDisplayDate(selectedDate)}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={(date) => date && setSelectedDate(date)}
                  disabled={(date) => date > getCentralDate()}
                />
              </PopoverContent>
            </Popover>
            
            <Button 
              variant="outline" 
              size="icon" 
              onClick={handleSync}
              disabled={isSyncing}
              data-testid="button-sync"
            >
              <RefreshCw className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>
        
        <p className="text-sm text-muted-foreground">
          Employee tenure breakdown by hour - identify inexperienced shifts
        </p>
        
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500" />
            <span className="text-xs text-muted-foreground">Trainee (&lt;90 days)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-orange-400" />
            <span className="text-xs text-muted-foreground">Developing (90d-1yr)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-xs text-muted-foreground">Experienced (1-2yr)</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-blue-500" />
            <span className="text-xs text-muted-foreground">Veteran (2yr+)</span>
          </div>
          
          <div className="ml-auto flex gap-2">
            <Button variant="outline" size="sm" onClick={expandAll}>
              Expand All
            </Button>
            <Button variant="outline" size="sm" onClick={collapseAll}>
              Collapse All
            </Button>
          </div>
        </div>
        
        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse">
                <div className="h-16 bg-muted rounded-lg" />
              </div>
            ))}
          </div>
        ) : storesWithData.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Users className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
              <p className="text-muted-foreground">No crew data available for this date.</p>
              <p className="text-sm text-muted-foreground mt-2">
                Click the sync button to load employee data from 7shifts.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {storesWithData.map(restaurant => (
              <Collapsible
                key={restaurant.restaurantId}
                open={expandedRestaurants.has(restaurant.restaurantId)}
                onOpenChange={() => toggleRestaurant(restaurant.restaurantId)}
              >
                <Card>
                  <CollapsibleTrigger asChild>
                    <CardHeader className="cursor-pointer hover-elevate py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-4">
                          <CardTitle className="text-base">
                            Unit #{restaurant.restaurantName.match(/\d+/)?.[0] || restaurant.restaurantName}
                          </CardTitle>
                          <span className="text-sm text-muted-foreground">
                            {restaurant.employeeCount || '-'} employees
                          </span>
                          <span className="text-sm text-muted-foreground">
                            Avg: {restaurant.avgTenure}
                          </span>
                          {restaurant.avgScore > 0 && (
                            <Badge 
                              className={`${getScoreColor(restaurant.avgScore)} text-white text-xs`}
                            >
                              {restaurant.avgScore}
                            </Badge>
                          )}
                        </div>
                        {expandedRestaurants.has(restaurant.restaurantId) ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </div>
                    </CardHeader>
                  </CollapsibleTrigger>
                  
                  <CollapsibleContent>
                    <CardContent className="pt-0">
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b text-muted-foreground">
                              <th className="text-left py-2 px-2 w-16">Hour</th>
                              <th className="text-center py-2 px-2 w-16">Crew</th>
                              <th className="text-left py-2 px-2 w-24">Avg Tenure</th>
                              <th className="text-center py-2 px-2 w-16">Score</th>
                              <th className="text-center py-2 px-2 w-20">Mix</th>
                              <th className="text-left py-2 px-2">Team</th>
                            </tr>
                          </thead>
                          <tbody>
                            {restaurant.hourly.map(hour => (
                              <tr key={hour.hour} className="border-b border-border/50">
                                <td className="py-2 px-2 font-medium">{hour.label}</td>
                                <td className="py-2 px-2 text-center">{hour.crewCount}</td>
                                <td className="py-2 px-2">{hour.avgTenure}</td>
                                <td className="py-2 px-2 text-center">
                                  <Badge 
                                    className={`${getScoreColor(hour.score)} text-white text-xs min-w-[2.5rem]`}
                                  >
                                    {hour.score}
                                  </Badge>
                                </td>
                                <td className="py-2 px-2 text-center">
                                  <span className="text-xs font-mono">{hour.mix}</span>
                                </td>
                                <td className="py-2 px-2">
                                  <div className="flex flex-wrap gap-1">
                                    {hour.team.map((member, idx) => (
                                      <Badge
                                        key={idx}
                                        variant="secondary"
                                        className={`${getCategoryColor(member.category)} text-white text-xs`}
                                      >
                                        {member.name}
                                      </Badge>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </CardContent>
                  </CollapsibleContent>
                </Card>
              </Collapsible>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
