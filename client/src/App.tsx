import { Switch, Route, Redirect, Link, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { lazy, Suspense } from "react";
import { Loader2, BarChart3 } from "lucide-react";

// Lazy-load all page components for route-level code splitting.
// Only the matched route's JS is downloaded, reducing initial bundle size.
const Dashboard = lazy(() => import("@/pages/dashboard"));
const SettingsPage = lazy(() => import("@/pages/settings"));
const HMETest = lazy(() => import("@/pages/hme-test"));
const HeatmapPage = lazy(() => import("@/pages/heatmap"));
const CrewExperiencePage = lazy(() => import("@/pages/crew-experience"));
const PerformanceHistoryPage = lazy(() => import("@/pages/performance-history"));
const LeadersPage = lazy(() => import("@/pages/leaders"));
const LoginPage = lazy(() => import("@/pages/login"));
const ScoringGuidePage = lazy(() => import("@/pages/scoring-guide"));
const AiAnalysisPage = lazy(() => import("@/pages/ai-analysis"));
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

function ExecSummaryFab() {
  const [location] = useLocation();
  const isActive = location === "/ai-analysis";
  if (isActive) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link href="/ai-analysis">
          <button
            data-testid="nav-executive-summary"
            className="fixed bottom-4 left-4 z-50 p-2.5 rounded-full bg-muted/80 backdrop-blur border border-border shadow-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <BarChart3 className="w-4 h-4" />
          </button>
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">Executive Summary</TooltipContent>
    </Tooltip>
  );
}

function ProtectedRoutes() {
  return (
    <AuthGuard>
      <ExecSummaryFab />
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/hme-test" component={HMETest} />
        <Route path="/dashboard-view" component={HeatmapPage} />
        <Route path="/crew" component={CrewExperiencePage} />
        <Route path="/history" component={PerformanceHistoryPage} />
        <Route path="/leaders" component={LeadersPage} />
        <Route path="/scoring" component={ScoringGuidePage} />
        <Route path="/ai-analysis" component={AiAnalysisPage} />
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
