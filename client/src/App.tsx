import { useEffect } from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import SettingsPage from "@/pages/settings";
import MapPage from "@/pages/map";
import HMETest from "@/pages/hme-test";
import HeatmapPage from "@/pages/heatmap";
import CrewExperiencePage from "@/pages/crew-experience";
import PerformanceHistoryPage from "@/pages/performance-history";
import LoginPage from "@/pages/login";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useQuery<{ authenticated: boolean; email?: string }>({
    queryKey: ["/api/auth/me"],
    retry: false,
    staleTime: 60000,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data?.authenticated) {
    return <Redirect to="/login" />;
  }

  return <>{children}</>;
}

function ProtectedRoutes() {
  return (
    <AuthGuard>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/map" component={MapPage} />
        <Route path="/hme-test" component={HMETest} />
        <Route path="/dashboard-view" component={HeatmapPage} />
        <Route path="/crew" component={CrewExperiencePage} />
        <Route path="/history" component={PerformanceHistoryPage} />
        <Route component={NotFound} />
      </Switch>
    </AuthGuard>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={100}>
        <Toaster />
        <Switch>
          <Route path="/login" component={LoginPage} />
          <Route>
            <ProtectedRoutes />
          </Route>
        </Switch>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
