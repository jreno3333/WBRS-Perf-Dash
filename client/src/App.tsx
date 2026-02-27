import { Switch, Route, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { lazy, Suspense } from "react";
import { Loader2 } from "lucide-react";

// Lazy-load all page components for route-level code splitting.
// Only the matched route's JS is downloaded, reducing initial bundle size.
const Dashboard = lazy(() => import("@/pages/dashboard"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const MapPage = lazy(() => import("@/pages/map"));
const HMETest = lazy(() => import("@/pages/hme-test"));
const HeatmapPage = lazy(() => import("@/pages/heatmap"));
const CrewExperiencePage = lazy(() => import("@/pages/crew-experience"));
const PerformanceHistoryPage = lazy(() => import("@/pages/performance-history"));
const LeadersPage = lazy(() => import("@/pages/leaders"));
const LoginPage = lazy(() => import("@/pages/login"));
const ArenaPage = lazy(() => import("@/pages/arena"));
const ComplaintsPage = lazy(() => import("@/pages/complaints"));
const NotFound = lazy(() => import("@/pages/not-found"));

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
        <Route path="/leaders" component={LeadersPage} />
        <Route path="/complaints" component={ComplaintsPage} />
        <Route component={NotFound} />
      </Switch>
    </AuthGuard>
  );
}

function PageLoadingFallback() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={100}>
        <Toaster />
        <Suspense fallback={<PageLoadingFallback />}>
          <Switch>
            <Route path="/login" component={LoginPage} />
            <Route path="/arena" component={ArenaPage} />
            <Route>
              <ProtectedRoutes />
            </Route>
          </Switch>
        </Suspense>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
