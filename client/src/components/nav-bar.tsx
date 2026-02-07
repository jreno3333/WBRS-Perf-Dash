import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Trophy, Grid3X3, TrendingUp, Users, MapPin, Settings } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const navItems = [
  { href: "/", icon: Trophy, title: "Leaderboard", testId: "nav-leaderboard" },
  { href: "/dashboard-view", icon: Grid3X3, title: "Daily Performance", testId: "nav-dashboard-view" },
  { href: "/history", icon: TrendingUp, title: "Performance Trends", testId: "nav-history" },
  { href: "/crew", icon: Users, title: "People", testId: "nav-crew" },
  { href: "/map", icon: MapPin, title: "Map", testId: "nav-map" },
  { href: "/settings", icon: Settings, title: "Settings", testId: "nav-settings" },
];

export function NavBar() {
  const [location] = useLocation();

  return (
    <div className="flex items-center gap-1">
      {navItems.map((item) => {
        const isActive = location === item.href;
        return (
          <Link key={item.href} href={item.href}>
            <Button
              variant={isActive ? "secondary" : "ghost"}
              size="icon"
              data-testid={item.testId}
              title={item.title}
            >
              <item.icon className="h-5 w-5" />
            </Button>
          </Link>
        );
      })}
      <ThemeToggle />
    </div>
  );
}
