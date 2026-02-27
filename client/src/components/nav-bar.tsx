import { Link, useLocation } from "wouter";
import { Trophy, Grid3X3, TrendingUp, Users, MapPin, Radio, AlertTriangle } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";

type NavItem = {
  href: string;
  icon: typeof Trophy;
  label: string;
  testId: string;
  external?: boolean;
};

const navItems: NavItem[] = [
  { href: "/", icon: Trophy, label: "Rankings", testId: "nav-leaderboard" },
  { href: "/dashboard-view", icon: Grid3X3, label: "Daily AI", testId: "nav-dashboard-view" },
  { href: "/history", icon: TrendingUp, label: "Trends", testId: "nav-history" },
  { href: "/crew", icon: Users, label: "People", testId: "nav-crew" },
  { href: "/complaints", icon: AlertTriangle, label: "Complaints", testId: "nav-complaints" },
  { href: "/map", icon: MapPin, label: "Map", testId: "nav-map" },
  { href: "https://mwbrealtime.wbrssystem.com", icon: Radio, label: "Real Time", testId: "nav-realtime", external: true },
];

export function NavBar() {
  const [location] = useLocation();

  return (
    <nav className="flex items-center gap-0.5 md:gap-1">
      {navItems.map((item) => {
        const isActive = !item.external && location === item.href;
        const buttonContent = (
          <button
            data-testid={item.testId}
            className={`
              flex items-center gap-1.5 px-1.5 md:px-3 py-1.5 rounded-lg text-sm font-medium transition-colors
              ${isActive
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
              }
            `}
          >
            <item.icon className="w-3.5 h-3.5" />
            <span className="hidden md:inline">{item.label}</span>
          </button>
        );

        if (item.external) {
          return (
            <a key={item.href} href={item.href} target="_blank" rel="noopener noreferrer">
              {buttonContent}
            </a>
          );
        }

        return (
          <Link key={item.href} href={item.href}>
            {buttonContent}
          </Link>
        );
      })}
      <div className="ml-0.5 md:ml-1 pl-0.5 md:pl-1 border-l border-border">
        <ThemeToggle />
      </div>
    </nav>
  );
}
