import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Dashboard from "@/pages/dashboard";
import SettingsPage from "@/pages/settings";
import MapPage from "@/pages/map";
import HMETest from "@/pages/hme-test";
import HeatmapPage from "@/pages/heatmap";
import CrewExperiencePage from "@/pages/crew-experience";
import PerformanceHistoryPage from "@/pages/performance-history";
import NotFound from "@/pages/not-found";

function Router() {
  return (
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
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={100}>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
