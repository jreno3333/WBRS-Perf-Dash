import { Link, useLocation } from "wouter";
import { Trophy, Grid3X3, TrendingUp, Users, MapPin } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

const navItems = [
  { href: "/", icon: Trophy, label: "Rankings", testId: "nav-leaderboard" },
  { href: "/dashboard-view", icon: Grid3X3, label: "Daily AI", testId: "nav-dashboard-view" },
  { href: "/history", icon: TrendingUp, label: "Trends", testId: "nav-history" },
  { href: "/crew", icon: Users, label: "People", testId: "nav-crew" },
  { href: "/map", icon: MapPin, label: "Map", testId: "nav-map" },
];

export function NavBar() {
  const [location] = useLocation();

  return (
    <nav className="flex items-center gap-0.5 sm:gap-1">
      {navItems.map((item) => {
        const isActive = location === item.href;
        return (
          <Link key={item.href} href={item.href}>
            <button
              data-testid={item.testId}
              className={`
                flex items-center gap-1.5 px-1.5 sm:px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
                ${isActive
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
                }
              `}
            >
              <item.icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{item.label}</span>
            </button>
          </Link>
        );
      })}
      <div className="ml-0.5 sm:ml-1 pl-0.5 sm:pl-1 border-l border-border">
        <ThemeToggle />
      </div>
    </nav>
  );
}
