import { useQuery } from "@tanstack/react-query";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import { Icon, DivIcon } from "leaflet";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Cloud, Sun, CloudRain, CloudSnow, Wind, Thermometer, Droplets, ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import "leaflet/dist/leaflet.css";

interface RestaurantMapData {
  id: string;
  name: string;
  unitNumber: string;
  address: string;
  latitude: number;
  longitude: number;
  todaySales: number;
  lastWeekSales: number;
  isAheadOfPace: boolean;
  status: "training" | "new" | "established";
  weather?: {
    temp: number;
    condition: string;
    humidity: number;
    windSpeed: number;
    icon: string;
  };
}

function createMarkerIcon(isAhead: boolean, status: string) {
  const color = status === "training" ? "#6b7280" : (isAhead ? "#22c55e" : "#ef4444");
  const size = 32;
  
  return new DivIcon({
    className: "custom-marker",
    html: `
      <div style="
        width: ${size}px;
        height: ${size}px;
        background-color: ${color};
        border: 3px solid white;
        border-radius: 50%;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        display: flex;
        align-items: center;
        justify-content: center;
      ">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="white">
          <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
        </svg>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    popupAnchor: [0, -size],
  });
}

function WeatherIcon({ condition }: { condition: string }) {
  const iconClass = "w-5 h-5";
  switch (condition?.toLowerCase()) {
    case "clear":
    case "sunny":
      return <Sun className={`${iconClass} text-yellow-500`} />;
    case "rain":
    case "drizzle":
    case "showers":
      return <CloudRain className={`${iconClass} text-blue-500`} />;
    case "snow":
      return <CloudSnow className={`${iconClass} text-blue-200`} />;
    case "windy":
      return <Wind className={`${iconClass} text-gray-500`} />;
    default:
      return <Cloud className={`${iconClass} text-gray-400`} />;
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

function MapBounds({ restaurants }: { restaurants: RestaurantMapData[] }) {
  const map = useMap();
  
  if (restaurants.length > 0) {
    const validRestaurants = restaurants.filter(r => r.latitude && r.longitude);
    if (validRestaurants.length > 0) {
      const bounds = validRestaurants.map(r => [r.latitude, r.longitude] as [number, number]);
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }
  
  return null;
}

export default function MapPage() {
  const { data: restaurants, isLoading } = useQuery<RestaurantMapData[]>({
    queryKey: ["/api/map-data"],
    refetchInterval: 60000,
  });

  const validRestaurants = restaurants?.filter(r => r.latitude && r.longitude) || [];
  const defaultCenter: [number, number] = [34.5, -86.5];

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center justify-between p-3 border-b bg-card">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="icon" data-testid="button-back">
              <ArrowLeft className="w-5 h-5" />
            </Button>
          </Link>
          <h1 className="text-lg font-semibold">Restaurant Map</h1>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-500" />
            <span className="text-muted-foreground">Ahead of LW</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-red-500" />
            <span className="text-muted-foreground">Behind LW</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-gray-500" />
            <span className="text-muted-foreground">Training</span>
          </div>
        </div>
      </header>

      <div className="flex-1 relative">
        {isLoading ? (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
          </div>
        ) : (
          <MapContainer
            center={defaultCenter}
            zoom={7}
            className="h-full w-full"
            scrollWheelZoom={true}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <MapBounds restaurants={validRestaurants} />
            
            {validRestaurants.map((restaurant) => (
              <Marker
                key={restaurant.id}
                position={[restaurant.latitude, restaurant.longitude]}
                icon={createMarkerIcon(restaurant.isAheadOfPace, restaurant.status)}
              >
                <Popup className="restaurant-popup">
                  <Card className="border-0 shadow-none min-w-[280px]">
                    <CardContent className="p-3 space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h3 className="font-semibold text-base">{restaurant.name}</h3>
                          <p className="text-xs text-muted-foreground">{restaurant.address}</p>
                        </div>
                        {restaurant.status === "training" && (
                          <Badge variant="secondary" className="text-xs">Training</Badge>
                        )}
                        {restaurant.status === "new" && (
                          <Badge className="bg-blue-500 text-white text-xs">New Unit</Badge>
                        )}
                      </div>

                      <div className="grid grid-cols-2 gap-2 text-sm">
                        <div>
                          <p className="text-muted-foreground text-xs">Today</p>
                          <p className="font-bold">{formatCurrency(restaurant.todaySales)}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground text-xs">Last Week</p>
                          <p className="font-medium">{formatCurrency(restaurant.lastWeekSales)}</p>
                        </div>
                      </div>

                      {restaurant.lastWeekSales > 0 ? (
                        <div className={`text-sm font-medium ${restaurant.isAheadOfPace ? "text-green-600" : "text-red-600"}`}>
                          {restaurant.isAheadOfPace ? "Ahead" : "Behind"} of last week by{" "}
                          {Math.abs(((restaurant.todaySales / restaurant.lastWeekSales) - 1) * 100).toFixed(1)}%
                        </div>
                      ) : (
                        <div className="text-sm font-medium text-muted-foreground">
                          No last week data for comparison
                        </div>
                      )}

                      {restaurant.weather && (
                        <div className="pt-2 border-t">
                          <div className="flex items-center gap-3">
                            <WeatherIcon condition={restaurant.weather.condition} />
                            <div className="flex-1">
                              <div className="flex items-center gap-2">
                                <Thermometer className="w-4 h-4 text-orange-500" />
                                <span className="font-medium">{Math.round(restaurant.weather.temp)}°F</span>
                                <span className="text-muted-foreground text-sm capitalize">
                                  {restaurant.weather.condition}
                                </span>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                                <span className="flex items-center gap-1">
                                  <Droplets className="w-3 h-3" />
                                  {restaurant.weather.humidity}%
                                </span>
                                <span className="flex items-center gap-1">
                                  <Wind className="w-3 h-3" />
                                  {Math.round(restaurant.weather.windSpeed)} mph
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        )}
      </div>
    </div>
  );
}
