import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Save } from "lucide-react";

// ─── CONSTANTS ───
const ORANGE = "#F58220";
const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const DAY_LABELS: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

const EVAL_OPTIONS = [
  { value: "hourly", label: "Every Hour" },
  { value: "end_of_shift", label: "End of Shift" },
  { value: "end_of_day", label: "End of Day" },
  { value: "end_of_week", label: "End of Week" },
  { value: "end_of_period", label: "End of Period" },
];
const WINDOW_OPTIONS = [
  { value: "hour", label: "Single Hour" }, { value: "shift", label: "Full Shift" },
  { value: "day", label: "Full Day" }, { value: "week", label: "Full Week" },
  { value: "rolling_days", label: "Rolling Days" }, { value: "rolling_shifts", label: "Rolling Shifts" },
];
const SCOPE_OPTIONS = [
  { value: "individual", label: "Individual (meets threshold)" },
  { value: "store", label: "Store-level (best in store)" },
  { value: "company_max", label: "Company Max (single winner)" },
];
const REWARD_OPTIONS = [
  { value: "leader", label: "Leader Only" }, { value: "unit", label: "Unit Only" },
  { value: "both", label: "Leader + Unit" }, { value: "shift_team", label: "Shift Team" },
];
const SHIFT_CREW_OPTIONS = [
  { value: "all_leaders", label: "All leaders on shift get credit" },
  { value: "primary_leader", label: "Primary (Manager) gets credit, others noted" },
  { value: "shift_team_named", label: "Named team — credited as a group" },
];
const OPERATOR_OPTIONS = [
  { value: "<", label: "< Less than" }, { value: "<=", label: "≤ At most" },
  { value: ">=", label: "≥ At least" }, { value: ">", label: "> Greater than" },
  { value: "=", label: "= Equals" }, { value: "max_company", label: "Company Max" },
  { value: "min_company", label: "Company Min (fastest)" },
];
const SHIFT_FILTER_OPTIONS = [
  { value: "", label: "Any Shift" }, { value: "opening", label: "Opening" },
  { value: "closing", label: "Closing" }, { value: "peak", label: "Peak Hours" },
];
const TIER_COLORS: Record<string, { bg: string; text: string }> = {
  bronze: { bg: "#CD7F32", text: "#fff" },
  silver: { bg: "#C0C0C0", text: "#333" },
  gold: { bg: "#FFD700", text: "#333" },
  platinum: { bg: "#E5E4E2", text: "#333" },
  orange: { bg: ORANGE, text: "#fff" },
};
const GRADE_COLORS: Record<string, string> = { "A+": "#15803d", A: "#22c55e", B: "#3b82f6", C: "#eab308", D: "#f97316", F: "#ef4444" };

// ─── TYPES ───
interface BadgeConfig {
  id: string; name: string; icon: string; customImage?: string | null;
  tier: string; category: string; active: boolean; desc: string;
  metric: string; operator: string; threshold: number; unit: string;
  tiebreaker: { metric: string; direction: string } | null;
  evalFrequency: string; timeWindow: string; windowDays: string[];
  windowLookback: number; hourFilter: { start: number; end: number } | null;
  shiftFilter: string | null; requireAllDays: boolean;
  scope: string; rewardTarget: string; shiftCrewMode: string; cooldown: number;
}

interface ArenaConfigData {
  badges: BadgeConfig[];
  streakConfig: {
    minGrade: string; trackBy: string; resetOn: string;
    weekDefinition: string[];
    milestones: { days: number; name: string; icon: string; tier: string; notify: boolean; rewardTarget: string }[];
  };
  shiftTeamConfig: {
    defaultCrewMode: string; roleHierarchy: string[];
    displayFormat: string; teamNameTemplate: string;
  };
  notifications: {
    channels: { email: boolean; sms: boolean; slack: boolean };
    autoMessages: { id: string; trigger: string; enabled: boolean; template: string; recipients: string }[];
    recipientGroups: Record<string, string>;
  };
  peakHours: { name: string; start: number; end: number }[];
  gradeThresholds: Record<string, number>;
  fiscalWeekStart: string;
}

// Record type display names and icons
const RECORD_TYPE_MAP: Record<string, { name: string; icon: string; format: (v: number) => string }> = {
  highest_hourly_sales: { name: "Honey Butter", icon: "💰", format: (v) => `$${v.toLocaleString()}/hr` },
  fastest_dt_avg: { name: "Drive-Thru Flyer", icon: "🏁", format: (v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")} avg` },
  best_daily_osat: { name: "Just Like You Like It", icon: "🏆", format: (v) => `${v}%` },
  longest_streak: { name: "Orange Legend", icon: "🔥", format: (v) => `${v} days` },
  most_transactions_hour: { name: "Table Stakes", icon: "👑", format: (v) => `${v} txns/hr` },
};

// ─── HELPER COMPONENTS ───
function BadgeIcon({ badge, size = 34, config }: { badge: string | BadgeConfig; size?: number; config?: ArenaConfigData }) {
  const b = typeof badge === "string"
    ? config?.badges?.find(x => x.id === badge) || { icon: "🏅", tier: "bronze", name: badge, desc: "", customImage: null }
    : badge;
  const tc = TIER_COLORS[b.tier] || TIER_COLORS.bronze;
  const hasImg = b.customImage && b.customImage.length > 0;
  return (
    <div
      title={`${b.name}: ${b.desc || ""}`}
      className="flex items-center justify-center rounded-full shrink-0 cursor-pointer transition-transform hover:scale-110 overflow-hidden"
      style={{
        width: size, height: size, background: hasImg ? "#222" : tc.bg,
        fontSize: size * 0.48,
        border: b.tier === "gold" ? "2px solid #DAA520" : b.tier === "platinum" ? "2px solid #B9B8B5" : b.tier === "orange" ? `2px solid ${ORANGE}` : "1px solid rgba(0,0,0,0.1)",
        boxShadow: b.tier === "orange" ? `0 0 8px ${ORANGE}50` : "0 1px 3px rgba(0,0,0,0.15)",
      }}
    >
      {hasImg ? <img src={b.customImage!} alt={b.name} className="w-full h-full object-cover rounded-full" /> : b.icon}
    </div>
  );
}

function StreakFire({ count }: { count: number }) {
  if (!count) return <span className="text-muted-foreground text-xs">—</span>;
  const color = count >= 10 ? "#ff4500" : count >= 5 ? ORANGE : "#ffaa00";
  return (
    <div className="flex items-center gap-1">
      <span className="text-sm" style={{ filter: count >= 10 ? "drop-shadow(0 0 4px #ff4500)" : "none" }}>🔥</span>
      <span className="font-bold text-xs font-mono" style={{ color }}>{count}d</span>
    </div>
  );
}

function GradeChip({ grade }: { grade: string }) {
  const color = GRADE_COLORS[grade] || "#888";
  return (
    <span className="px-2 py-0.5 rounded font-bold text-xs font-mono" style={{ background: color, color: grade === "C" ? "#333" : "#fff" }}>
      {grade}
    </span>
  );
}

function TrendArrow({ t }: { t: string }) {
  if (t === "up") return <span className="text-green-500">▲</span>;
  if (t === "down") return <span className="text-red-500">▼</span>;
  return <span className="text-muted-foreground">—</span>;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] uppercase tracking-wider text-muted-foreground block mb-1">{children}</label>;
}

function DayPicker({ selected, onChange, label }: { selected: string[]; onChange: (v: string[]) => void; label?: string }) {
  return (
    <div>
      {label && <FieldLabel>{label}</FieldLabel>}
      <div className="flex gap-1">
        {DAYS.map(d => {
          const active = selected.includes(d);
          return (
            <button key={d} onClick={() => onChange(active ? selected.filter(x => x !== d) : [...selected, d])}
              className="w-8 h-7 rounded text-[10px] font-bold border-none cursor-pointer transition-all"
              style={{ background: active ? ORANGE : "rgba(255,255,255,0.08)", color: active ? "#fff" : "#888" }}>
              {DAY_LABELS[d]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── MAIN ARENA PAGE ───
export default function ArenaPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // Key gate — check URL params
  const searchParams = new URLSearchParams(window.location.search);
  const accessKey = searchParams.get("key");

  // State
  const [mainTab, setMainTab] = useState("overview");
  const [settingsTab, setSettingsTab] = useState("badges");
  const [editingBadge, setEditingBadge] = useState<string | null>(null);
  const [editingNotif, setEditingNotif] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [badgeFilter, setBadgeFilter] = useState("all");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeMsg, setComposeMsg] = useState("");
  const [composeType, setComposeType] = useState("praise");

  // Fetch config
  const { data: configData, isLoading, error } = useQuery<{ config: ArenaConfigData; id: string; updatedAt: string }>({
    queryKey: ["/api/arena/config", accessKey],
    queryFn: async () => {
      const res = await fetch(`/api/arena/config?key=${accessKey || ""}`);
      if (res.status === 403) throw new Error("ACCESS_DENIED");
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Server error (${res.status})`);
      }
      return res.json();
    },
    retry: false,
  });

  const [cfg, setCfg] = useState<ArenaConfigData | null>(null);

  // Sync config from server
  useEffect(() => {
    if (configData?.config && !cfg) {
      setCfg(configData.config as ArenaConfigData);
    }
  }, [configData, cfg]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (config: ArenaConfigData) => {
      const res = await fetch(`/api/arena/config?key=${accessKey || ""}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to save config");
      return res.json();
    },
    onSuccess: () => {
      setDirty(false);
      toast({ title: "Config saved", description: "Arena configuration updated successfully." });
      queryClient.invalidateQueries({ queryKey: ["/api/arena/config"] });
    },
    onError: (err: Error) => {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  // Fetch command center data
  const { data: commandCenter } = useQuery({
    queryKey: ["/api/arena/command-center", accessKey],
    queryFn: async () => {
      const res = await fetch(`/api/arena/command-center?key=${accessKey || ""}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: !!configData,
    refetchInterval: 60000,
  });

  // Fetch leader rankings
  const { data: leaderboard } = useQuery<{ leaders: any[] }>({
    queryKey: ["/api/arena/leaderboard", accessKey],
    queryFn: async () => {
      const res = await fetch(`/api/arena/leaderboard?key=${accessKey || ""}`);
      if (!res.ok) return { leaders: [] };
      return res.json();
    },
    enabled: !!configData,
    refetchInterval: 60000,
  });

  // Fetch unit rankings
  const { data: unitRankings } = useQuery<{ units: any[] }>({
    queryKey: ["/api/arena/units", accessKey],
    queryFn: async () => {
      const res = await fetch(`/api/arena/units?key=${accessKey || ""}`);
      if (!res.ok) return { units: [] };
      return res.json();
    },
    enabled: !!configData,
    refetchInterval: 60000,
  });

  // Fetch records
  const { data: records } = useQuery<any[]>({
    queryKey: ["/api/arena/records", accessKey],
    queryFn: async () => {
      const res = await fetch(`/api/arena/records?key=${accessKey || ""}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!configData,
  });

  // Fetch messages
  const { data: messages } = useQuery<any[]>({
    queryKey: ["/api/arena/messages", accessKey],
    queryFn: async () => {
      const res = await fetch(`/api/arena/messages?key=${accessKey || ""}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!configData,
  });

  // Loading / error states
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#111" }}>
        <Loader2 className="h-8 w-8 animate-spin" style={{ color: ORANGE }} />
      </div>
    );
  }

  if (error || !configData) {
    const isAccessDenied = error?.message === "ACCESS_DENIED";
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#111" }}>
        <Card className="p-8 text-center max-w-md" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
          {isAccessDenied || !accessKey ? (
            <>
              <h2 className="text-xl font-bold text-white mb-2">Arena Access Required</h2>
              <p className="text-muted-foreground text-sm">Access this page with <code className="px-1 py-0.5 rounded text-xs" style={{ background: "rgba(255,255,255,0.1)", color: ORANGE }}>/arena?key=mwb2026</code></p>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold text-white mb-2">Arena Loading Error</h2>
              <p className="text-muted-foreground text-sm mb-3">{error?.message || "Unable to load arena config"}</p>
              <p className="text-muted-foreground text-xs">Have you run <code className="px-1 py-0.5 rounded text-xs" style={{ background: "rgba(255,255,255,0.1)", color: ORANGE }}>npm run db:push</code> to create the Arena tables?</p>
            </>
          )}
        </Card>
      </div>
    );
  }

  if (!cfg) return null;

  // ─── Config update helpers ───
  const updateBadge = (id: string, field: string, value: any) => {
    setCfg(prev => prev ? { ...prev, badges: prev.badges.map(b => b.id === id ? { ...b, [field]: value } : b) } : prev);
    setDirty(true);
  };
  const updateNotif = (id: string, field: string, value: any) => {
    setCfg(prev => {
      if (!prev) return prev;
      return {
        ...prev, notifications: {
          ...prev.notifications,
          autoMessages: prev.notifications.autoMessages.map(n => n.id === id ? { ...n, [field]: value } : n),
        }
      };
    });
    setDirty(true);
  };
  const updateMilestone = (idx: number, field: string, value: any) => {
    setCfg(prev => {
      if (!prev) return prev;
      const n = JSON.parse(JSON.stringify(prev));
      n.streakConfig.milestones[idx][field] = value;
      return n;
    });
    setDirty(true);
  };
  const updateConfig = (path: string, value: any) => {
    setCfg(prev => {
      if (!prev) return prev;
      const n = JSON.parse(JSON.stringify(prev));
      const parts = path.split(".");
      let t: any = n;
      for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]];
      t[parts[parts.length - 1]] = value;
      return n;
    });
    setDirty(true);
  };
  const addBadge = () => {
    const id = `custom_${Date.now()}`;
    setCfg(prev => prev ? {
      ...prev, badges: [...prev.badges, {
        id, name: "New Badge", icon: "🏅", customImage: null, tier: "bronze", category: "leader",
        active: true, desc: "", metric: "", operator: ">=", threshold: 0, unit: "score",
        evalFrequency: "end_of_day", timeWindow: "day", windowDays: [], windowLookback: 0,
        hourFilter: null, shiftFilter: null, requireAllDays: false,
        scope: "individual", rewardTarget: "leader", shiftCrewMode: "all_leaders",
        tiebreaker: null, cooldown: 0,
      }]
    } : prev);
    setEditingBadge(id);
    setDirty(true);
  };

  const handleSave = () => {
    if (cfg) saveMutation.mutate(cfg);
  };

  return (
    <div className="min-h-screen" style={{ background: "#111", fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Google Fonts */}
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />

      {/* ─── HEADER ─── */}
      <div className="border-b-[3px] px-5 py-4" style={{ background: "linear-gradient(135deg, #1a1a1a 0%, #2d1a0a 100%)", borderColor: ORANGE }}>
        <div className="max-w-[1200px] mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center font-black text-white text-base font-mono tracking-tighter"
              style={{ background: `linear-gradient(135deg, ${ORANGE}, #e5740c)` }}>W</div>
            <div>
              <h1 className="text-lg font-bold text-white m-0">MWB <span style={{ color: ORANGE }}>PERFORMANCE</span> ARENA</h1>
              <p className="text-[10px] text-muted-foreground m-0">Pride · Care · Love — Powered by Orange Spirit</p>
            </div>
          </div>
          {dirty && (
            <Button onClick={handleSave} disabled={saveMutation.isPending} className="gap-2" style={{ background: "#22c55e" }}>
              <Save className="h-4 w-4" />
              {saveMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          )}
        </div>
        {/* Tab navigation */}
        <div className="flex gap-1 mt-3 max-w-[1200px] mx-auto overflow-x-auto">
          {[
            { key: "overview", label: "Command Center" },
            { key: "leaders", label: "Leaders" },
            { key: "units", label: "Units" },
            { key: "badges", label: "Badges" },
            { key: "records", label: "Records" },
            { key: "push", label: "Messages" },
            { key: "settings", label: "Settings" },
          ].map(t => (
            <button key={t.key} onClick={() => setMainTab(t.key)}
              className="px-3 py-1.5 rounded-md border-none cursor-pointer font-semibold text-[11px] whitespace-nowrap transition-all"
              style={{ background: mainTab === t.key ? ORANGE : "rgba(255,255,255,0.06)", color: mainTab === t.key ? "#fff" : "#999" }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ─── CONTENT ─── */}
      <div className="max-w-[1200px] mx-auto px-5 py-5">

        {/* ═══ COMMAND CENTER ═══ */}
        {mainTab === "overview" && (
          <div>
            {/* Quick stats */}
            <div className="grid grid-cols-4 gap-3 mb-4">
              {[
                { l: "Active Streaks", v: commandCenter?.activeStreaks ?? 0, i: "🔥" },
                { l: "Badges Today", v: commandCenter?.badgesToday ?? 0, i: "🏅" },
                { l: "A+ Hours Today", v: commandCenter?.aplusHoursToday ?? 0, i: "🍔" },
                { l: "Team Badges", v: commandCenter?.teamBadgesToday ?? 0, i: "👥" },
              ].map((s, i) => (
                <div key={i} className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="flex justify-between">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground">{s.l}</div>
                      <div className="text-white text-2xl font-bold font-mono mt-1">{s.v}</div>
                    </div>
                    <span className="text-xl">{s.i}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Spotlight */}
            {commandCenter?.spotlight ? (
              <div className="rounded-xl p-4 mb-4 relative overflow-hidden" style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${ORANGE}40` }}>
                <div className="absolute -right-2 -top-2 text-6xl opacity-5">👑</div>
                <div className="text-[10px] uppercase tracking-[2px] font-bold" style={{ color: ORANGE }}>Today's Spotlight</div>
                <div className="flex justify-between items-center mt-2">
                  <div>
                    <div className="text-white text-lg font-bold">{commandCenter.spotlight.entityName}</div>
                    <div className="text-muted-foreground text-xs mt-1">
                      {commandCenter.spotlight.badgeCount ? `${commandCenter.spotlight.badgeCount} badges earned today` : ""}
                      {commandCenter.spotlight.streakCount ? `${commandCenter.spotlight.streakCount}-day streak` : ""}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {(commandCenter.spotlight.badges || []).slice(0, 4).map((b: string) => (
                      <BadgeIcon key={b} badge={b} size={32} config={cfg} />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <div className="text-muted-foreground text-xs text-center py-2">No spotlight data yet — badges will appear as they're earned</div>
              </div>
            )}

            {/* Two columns */}
            <div className="grid grid-cols-2 gap-3">
              {/* Streak Leaderboard */}
              <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <h3 className="text-white text-sm font-semibold mb-3">🔥 Streak Leaderboard</h3>
                {(commandCenter?.streakLeaders || []).length === 0 ? (
                  <div className="text-muted-foreground text-xs text-center py-4">No active streaks yet</div>
                ) : (
                  (commandCenter.streakLeaders as any[]).map((s: any, i: number) => (
                    <div key={s.id} className="flex items-center justify-between px-2.5 py-2 rounded-md mb-1"
                      style={{ background: i === 0 ? "rgba(245,130,32,0.07)" : "transparent" }}>
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-xs w-5 font-mono" style={{ color: i === 0 ? ORANGE : "#555" }}>#{i + 1}</span>
                        <div>
                          <div className="text-white font-semibold text-xs">{s.entityName || s.entity_name}</div>
                          <div className="text-muted-foreground text-[10px]">{s.entityType || s.entity_type}</div>
                        </div>
                      </div>
                      <StreakFire count={s.streakCount ?? s.streak_count ?? 0} />
                    </div>
                  ))
                )}
              </div>

              {/* Company Records */}
              <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <h3 className="text-white text-sm font-semibold mb-3">🏆 Company Records</h3>
                {(commandCenter?.companyRecords || []).length === 0 ? (
                  <div className="text-muted-foreground text-xs text-center py-4">No records set yet</div>
                ) : (
                  (commandCenter.companyRecords as any[]).map((r: any, i: number) => {
                    const rt = RECORD_TYPE_MAP[r.record_type] || { name: r.record_type, icon: "📊", format: (v: number) => String(v) };
                    return (
                      <div key={i} className="px-2.5 py-2 rounded-md mb-1" style={{ borderLeft: `3px solid ${ORANGE}`, background: "rgba(255,255,255,0.02)" }}>
                        <div className="text-white font-semibold text-[11px]">{rt.icon} {rt.name}</div>
                        <div className="flex justify-between mt-1">
                          <span className="font-bold text-xs font-mono" style={{ color: ORANGE }}>{rt.format(Number(r.value))}</span>
                          <span className="text-muted-foreground text-[10px]">{r.holder_name}</span>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* ═══ LEADERS ═══ */}
        {mainTab === "leaders" && (
          <div>
            <h2 className="text-white text-base font-semibold mb-3">Community Member Rankings</h2>
            {!leaderboard?.leaders?.length ? (
              <div className="rounded-xl p-8 text-center" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" style={{ color: ORANGE }} />
                <div className="text-muted-foreground text-xs">Loading leader rankings...</div>
              </div>
            ) : (
              <div className="rounded-xl overflow-hidden" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                {/* Header */}
                <div className="grid px-3.5 py-2.5" style={{ gridTemplateColumns: "40px 1fr 70px 60px 70px 140px", background: "rgba(255,255,255,0.04)", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                  {["#", "Leader", "Avg", "Today", "Streak", "Badges"].map(h => (
                    <div key={h} className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">{h}</div>
                  ))}
                </div>
                {/* Rows */}
                {leaderboard.leaders.map((l: any, i: number) => (
                  <div key={l.id} className="grid items-center px-3.5 py-3" style={{
                    gridTemplateColumns: "40px 1fr 70px 60px 70px 140px",
                    borderBottom: "1px solid rgba(255,255,255,0.04)",
                    background: i === 0 ? "rgba(245,130,32,0.04)" : "transparent"
                  }}>
                    <span className="font-bold text-sm font-mono" style={{ color: i < 3 ? ORANGE : "#555" }}>
                      {i === 0 ? "👑" : i + 1}
                    </span>
                    <div>
                      <div className="text-white font-semibold text-xs">{l.name}</div>
                      <div className="text-muted-foreground text-[10px]">{l.store} · {l.storeName} · {l.role}</div>
                      {l.team?.length > 1 && <div className="text-[9px] mt-0.5" style={{ color: "#444" }}>Shift team: {l.team.join(", ")}</div>}
                    </div>
                    <span className="text-white font-bold font-mono text-sm">{l.avgGradeScore}</span>
                    <GradeChip grade={l.todayGrade} />
                    <StreakFire count={l.streak} />
                    <div className="flex gap-1 flex-wrap">
                      {(l.badges || []).slice(0, 4).map((b: string) => <BadgeIcon key={b} badge={b} size={24} config={cfg} />)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══ UNITS ═══ */}
        {mainTab === "units" && (
          <div>
            <h2 className="text-white text-base font-semibold mb-3">Unit Rankings</h2>
            {!unitRankings?.units?.length ? (
              <div className="rounded-xl p-8 text-center" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" style={{ color: ORANGE }} />
                <div className="text-muted-foreground text-xs">Loading unit rankings...</div>
              </div>
            ) : (
              unitRankings.units.map((u: any, i: number) => (
                <div key={u.id} className="rounded-xl p-4 mb-2" style={{
                  background: "rgba(255,255,255,0.04)",
                  border: i === 0 ? `1px solid ${ORANGE}40` : "1px solid rgba(255,255,255,0.08)"
                }}>
                  <div className="grid items-center gap-3" style={{ gridTemplateColumns: "50px 1fr auto" }}>
                    <div className="text-center">
                      <div className="font-bold text-lg font-mono" style={{ color: i < 3 ? ORANGE : "#555" }}>
                        {i === 0 ? "👑" : `#${i + 1}`}
                      </div>
                      <GradeChip grade={u.dailyGrade} />
                    </div>
                    <div>
                      <div className="text-white font-bold text-sm">{u.id} — {u.name}</div>
                      <div className="text-muted-foreground text-[11px] mt-0.5">
                        Score: <span className="font-mono" style={{ color: ORANGE }}>{u.score}</span>
                        {u.streak > 0 && <span className="ml-2 inline-flex"><StreakFire count={u.streak} /></span>}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      {(u.badges || []).map((b: string) => <BadgeIcon key={b} badge={b} size={28} config={cfg} />)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* ═══ BADGES ═══ */}
        {mainTab === "badges" && (
          <div>
            <h2 className="text-white text-base font-semibold mb-3">Badge Catalog</h2>
            <div className="flex gap-1 mb-4">
              {["all", "unit", "leader"].map(f => (
                <button key={f} onClick={() => setBadgeFilter(f)}
                  className="px-3 py-1 rounded text-[11px] font-semibold capitalize border-none cursor-pointer"
                  style={{ background: badgeFilter === f ? ORANGE : "rgba(255,255,255,0.08)", color: badgeFilter === f ? "#fff" : "#999" }}>
                  {f}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-3 gap-3">
              {cfg.badges.filter(b => b.active && (badgeFilter === "all" || b.category === badgeFilter)).map(b => (
                <div key={b.id} className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="flex gap-2.5 items-start">
                    <BadgeIcon badge={b} size={40} config={cfg} />
                    <div>
                      <div className="text-white font-bold text-sm">{b.name}</div>
                      <div className="flex gap-1 mt-1 flex-wrap">
                        <span className="text-[9px] uppercase px-1.5 py-0.5 rounded" style={{ color: ORANGE, background: `${ORANGE}15` }}>{b.tier}</span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: "#3b82f6", background: "rgba(59,130,246,0.1)" }}>
                          → {b.rewardTarget === "shift_team" ? "shift team" : b.rewardTarget}
                        </span>
                        <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: "#666", background: "rgba(255,255,255,0.06)" }}>
                          {b.evalFrequency.replace("end_of_", "")}
                        </span>
                      </div>
                      <div className="text-muted-foreground text-[11px] mt-1 leading-snug">{b.desc}</div>
                      {b.rewardTarget === "shift_team" && (
                        <div className="text-green-500 text-[9px] mt-1">
                          👥 {b.shiftCrewMode === "all_leaders" ? "All leaders credited" : b.shiftCrewMode === "primary_leader" ? "Manager gets primary credit" : "Named team credited"}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ═══ RECORDS ═══ */}
        {mainTab === "records" && (
          <div>
            <h2 className="text-white text-base font-semibold mb-3">Company Records</h2>
            {!records?.length ? (
              <div className="rounded-xl p-8 text-center" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <div className="text-muted-foreground text-xs">No records set yet — records are tracked as badges are earned</div>
              </div>
            ) : (
              records.map((r: any, i: number) => {
                const rt = RECORD_TYPE_MAP[r.recordType || r.record_type] || { name: r.recordType || r.record_type, icon: "📊", format: (v: number) => String(v) };
                return (
                  <div key={r.id || i} className="rounded-xl p-4 mb-2" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <div className="grid items-center" style={{ gridTemplateColumns: "1fr auto" }}>
                      <div>
                        <div className="text-white font-bold text-sm">{rt.icon} {rt.name}</div>
                        <div className="text-muted-foreground text-[11px] mt-1">
                          {r.holderName || r.holder_name} — <span style={{ color: ORANGE }}>{r.evalDate || r.eval_date}</span>
                        </div>
                      </div>
                      <div className="rounded-lg px-4 py-2 text-center" style={{ background: `${ORANGE}12` }}>
                        <div className="font-bold text-lg font-mono" style={{ color: ORANGE }}>{rt.format(Number(r.value))}</div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ═══ MESSAGES ═══ */}
        {mainTab === "push" && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-white text-base font-semibold m-0">Push Messages</h2>
              <Button onClick={() => setComposeOpen(!composeOpen)} style={{ background: ORANGE }}>Compose</Button>
            </div>

            {composeOpen && (
              <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${ORANGE}40` }}>
                <div className="grid grid-cols-2 gap-3 mb-3">
                  <div>
                    <FieldLabel>To</FieldLabel>
                    <select value={composeTo} onChange={e => setComposeTo(e.target.value)}
                      className="w-full p-1.5 rounded border text-xs text-white"
                      style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                      <option value="">Select...</option>
                      <option value="__team__">— Entire Shift Team —</option>
                      {(leaderboard?.leaders || []).map((l: any) => <option key={l.id} value={l.name}>{l.name} — {l.store}</option>)}
                    </select>
                  </div>
                  <div>
                    <FieldLabel>Type</FieldLabel>
                    <div className="flex gap-1">
                      {(["praise", "coaching"] as const).map(t => (
                        <button key={t} onClick={() => setComposeType(t)}
                          className="flex-1 py-1.5 rounded border-none cursor-pointer text-white font-semibold text-[11px] capitalize"
                          style={{ background: composeType === t ? (t === "praise" ? "#22c55e" : "#3b82f6") : "rgba(255,255,255,0.08)" }}>
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <Textarea value={composeMsg} onChange={e => setComposeMsg(e.target.value)}
                  placeholder="Write message..." className="mb-2 text-xs min-h-[60px]"
                  style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }} />
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setComposeOpen(false)}>Cancel</Button>
                  <Button size="sm" style={{ background: ORANGE }}>Send →</Button>
                </div>
              </div>
            )}

            {!messages?.length ? (
              <div className="rounded-xl p-8 text-center" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <div className="text-muted-foreground text-xs">No messages yet</div>
              </div>
            ) : (
              messages.map((m: any, i: number) => {
                const msgType = m.messageType || m.message_type || "praise";
                const isAuto = m.auto ?? true;
                const isTeam = m.team ?? false;
                const sentTime = m.sentAt || m.sent_at ? new Date(m.sentAt || m.sent_at).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" }) : "";
                return (
                  <div key={m.id || i} className="rounded-xl p-3 mb-1.5" style={{
                    background: "rgba(255,255,255,0.04)",
                    borderLeft: `3px solid ${msgType === "praise" ? "#22c55e" : "#3b82f6"}`,
                    border: "1px solid rgba(255,255,255,0.08)",
                  }}>
                    <div className="flex justify-between">
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
                            style={{ background: msgType === "praise" ? "rgba(34,197,94,0.15)" : "rgba(59,130,246,0.15)", color: msgType === "praise" ? "#22c55e" : "#3b82f6" }}>
                            {msgType}
                          </span>
                          {isAuto && <span className="text-muted-foreground text-[9px]">Auto</span>}
                          {isTeam && <span className="text-[9px] px-1 py-0.5 rounded" style={{ color: ORANGE, background: `${ORANGE}15` }}>👥 Team</span>}
                        </div>
                        <div className="text-white font-semibold text-xs mt-1">
                          To: {m.recipientName || m.recipient_name || "—"} <span className="text-muted-foreground">({m.restaurantId || m.restaurant_id || ""})</span>
                        </div>
                        <div className="text-muted-foreground text-[11px] mt-1">{m.message}</div>
                      </div>
                      <span className="text-muted-foreground text-[10px] whitespace-nowrap ml-4">{sentTime}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {/* ═══ SETTINGS ═══ */}
        {mainTab === "settings" && (
          <div>
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-white text-base font-semibold m-0">Arena Configuration</h2>
                <p className="text-muted-foreground text-xs mt-1">All rules editable — no code changes needed</p>
              </div>
              {dirty && (
                <Button onClick={handleSave} disabled={saveMutation.isPending} className="gap-2" style={{ background: "#22c55e" }}>
                  <Save className="h-4 w-4" />
                  {saveMutation.isPending ? "Saving..." : "Save Changes"}
                </Button>
              )}
            </div>

            {/* Settings sub-tabs */}
            <div className="flex gap-1 mb-4">
              {[
                { k: "badges", l: "Badge Rules" },
                { k: "shiftTeam", l: "Shift Teams" },
                { k: "streaks", l: "Streaks" },
                { k: "notifications", l: "Notifications" },
                { k: "thresholds", l: "Grades & Timing" },
              ].map(t => (
                <button key={t.k} onClick={() => setSettingsTab(t.k)}
                  className="px-3 py-1.5 rounded-md cursor-pointer font-semibold text-[11px] transition-all"
                  style={{
                    border: settingsTab === t.k ? `1px solid ${ORANGE}` : "1px solid rgba(255,255,255,0.1)",
                    background: settingsTab === t.k ? `${ORANGE}12` : "transparent",
                    color: settingsTab === t.k ? ORANGE : "#999",
                  }}>
                  {t.l}
                </button>
              ))}
            </div>

            {/* ── BADGE RULES ── */}
            {settingsTab === "badges" && (
              <div>
                <div className="flex justify-between items-center mb-3">
                  <span className="text-muted-foreground text-xs">{cfg.badges.length} badges · {cfg.badges.filter(b => b.active).length} active</span>
                  <button onClick={addBadge} className="px-3 py-1.5 rounded text-[11px] font-semibold cursor-pointer"
                    style={{ border: `1px dashed ${ORANGE}`, background: "transparent", color: ORANGE }}>+ Add Badge</button>
                </div>

                {cfg.badges.map(b => (
                  <div key={b.id} className="rounded-xl mb-2" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", padding: editingBadge === b.id ? 16 : 12 }}>
                    {editingBadge === b.id ? (
                      /* ── EXPANDED EDITOR ── */
                      <div>
                        <div className="flex justify-between mb-3">
                          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: ORANGE }}>Editing: {b.name}</span>
                          <div className="flex gap-1.5">
                            <button onClick={() => { setCfg(prev => prev ? { ...prev, badges: prev.badges.filter(x => x.id !== b.id) } : prev); setEditingBadge(null); setDirty(true); }}
                              className="px-2.5 py-1 rounded text-[10px] cursor-pointer" style={{ border: "1px solid #ef444450", background: "transparent", color: "#ef4444" }}>Delete</button>
                            <button onClick={() => setEditingBadge(null)}
                              className="px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer border-none text-white" style={{ background: ORANGE }}>Done</button>
                          </div>
                        </div>

                        {/* Identity */}
                        <div className="rounded-lg p-3 mb-2" style={{ background: "rgba(255,255,255,0.02)" }}>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Identity</div>
                          <div className="grid grid-cols-4 gap-2">
                            <div><FieldLabel>Icon</FieldLabel><Input value={b.icon} onChange={e => updateBadge(b.id, "icon", e.target.value)} className="h-8 text-xs" /></div>
                            <div className="col-span-1"><FieldLabel>Name</FieldLabel><Input value={b.name} onChange={e => updateBadge(b.id, "name", e.target.value)} className="h-8 text-xs" /></div>
                            <div>
                              <FieldLabel>Tier</FieldLabel>
                              <select value={b.tier} onChange={e => updateBadge(b.id, "tier", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {["bronze", "silver", "gold", "platinum", "orange"].map(t => <option key={t} value={t}>{t}</option>)}
                              </select>
                            </div>
                            <div>
                              <FieldLabel>Category</FieldLabel>
                              <select value={b.category} onChange={e => updateBadge(b.id, "category", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {["unit", "leader"].map(c => <option key={c} value={c}>{c}</option>)}
                              </select>
                            </div>
                          </div>
                          <div className="mt-2"><FieldLabel>Description</FieldLabel><Input value={b.desc} onChange={e => updateBadge(b.id, "desc", e.target.value)} placeholder="What earns this badge?" className="h-8 text-xs" /></div>
                          {/* Custom image */}
                          <div className="mt-2">
                            <FieldLabel>Custom Badge Image</FieldLabel>
                            <div className="flex items-center gap-2">
                              <BadgeIcon badge={b} size={44} config={cfg} />
                              <div className="flex-1">
                                <div className="flex gap-1.5 items-center">
                                  <Input value={b.customImage || ""} onChange={e => updateBadge(b.id, "customImage", e.target.value || null)} placeholder="Image URL" className="h-8 text-xs" />
                                  {b.customImage && <button onClick={() => updateBadge(b.id, "customImage", null)} className="px-2 py-1 rounded text-[9px] cursor-pointer" style={{ border: "1px solid #ef444440", background: "transparent", color: "#ef4444" }}>Remove</button>}
                                </div>
                                <div className="text-muted-foreground text-[9px] mt-1">{b.customImage ? "Custom image active" : "Using emoji fallback"}</div>
                              </div>
                            </div>
                          </div>
                        </div>

                        {/* What to Measure */}
                        <div className="rounded-lg p-3 mb-2" style={{ background: "rgba(255,255,255,0.02)" }}>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">What to Measure</div>
                          <div className="grid grid-cols-4 gap-2">
                            <div><FieldLabel>Metric</FieldLabel><Input value={b.metric} onChange={e => updateBadge(b.id, "metric", e.target.value)} placeholder="e.g. dt_speed_avg" className="h-8 text-xs" /></div>
                            <div>
                              <FieldLabel>Operator</FieldLabel>
                              <select value={b.operator} onChange={e => updateBadge(b.id, "operator", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {OPERATOR_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                            <div><FieldLabel>Threshold</FieldLabel><Input type="number" value={b.threshold} onChange={e => updateBadge(b.id, "threshold", Number(e.target.value))} className="h-8 text-xs" /></div>
                            <div>
                              <FieldLabel>Unit</FieldLabel>
                              <select value={b.unit} onChange={e => updateBadge(b.id, "unit", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {["score", "seconds", "percent", "count", "dollars", "points", "shifts", "days", "boolean"].map(u => <option key={u} value={u}>{u}</option>)}
                              </select>
                            </div>
                          </div>
                          {/* Tiebreaker */}
                          <div className="mt-2">
                            <FieldLabel>Tiebreaker</FieldLabel>
                            <div className="flex items-center gap-2">
                              <Switch checked={b.tiebreaker !== null} onCheckedChange={v => updateBadge(b.id, "tiebreaker", v ? { metric: "", direction: "desc" } : null)} />
                              {b.tiebreaker && (
                                <>
                                  <Input value={b.tiebreaker.metric} onChange={e => updateBadge(b.id, "tiebreaker", { ...b.tiebreaker!, metric: e.target.value })} placeholder="tiebreaker metric" className="h-8 text-xs" />
                                  <select value={b.tiebreaker.direction} onChange={e => updateBadge(b.id, "tiebreaker", { ...b.tiebreaker!, direction: e.target.value })} className="h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                    <option value="desc">Highest wins</option>
                                    <option value="asc">Lowest wins</option>
                                  </select>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* When to Evaluate */}
                        <div className="rounded-lg p-3 mb-2" style={{ background: `rgba(245,130,32,0.04)`, border: `1px solid ${ORANGE}15` }}>
                          <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: ORANGE }}>When to Evaluate</div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <FieldLabel>Eval Frequency</FieldLabel>
                              <select value={b.evalFrequency} onChange={e => updateBadge(b.id, "evalFrequency", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {EVAL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                            <div>
                              <FieldLabel>Time Window</FieldLabel>
                              <select value={b.timeWindow} onChange={e => updateBadge(b.id, "timeWindow", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {WINDOW_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                            {(b.timeWindow === "rolling_days" || b.timeWindow === "rolling_shifts") && (
                              <div><FieldLabel>Lookback</FieldLabel><Input type="number" value={b.windowLookback} onChange={e => updateBadge(b.id, "windowLookback", Number(e.target.value))} className="h-8 text-xs" /></div>
                            )}
                          </div>
                          <div className="grid grid-cols-2 gap-3 mt-3">
                            <DayPicker label="Active Days (empty = all)" selected={b.windowDays} onChange={v => updateBadge(b.id, "windowDays", v)} />
                            <div>
                              <div className="flex items-center gap-2 mb-2">
                                <Switch checked={b.requireAllDays} onCheckedChange={v => updateBadge(b.id, "requireAllDays", v)} />
                                <span className="text-muted-foreground text-xs">Must meet ALL days</span>
                              </div>
                              <FieldLabel>Shift Filter</FieldLabel>
                              <select value={b.shiftFilter || ""} onChange={e => updateBadge(b.id, "shiftFilter", e.target.value || null)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {SHIFT_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                          </div>
                          {/* Hour Filter */}
                          <div className="mt-3">
                            <FieldLabel>Hour Filter</FieldLabel>
                            <div className="flex items-center gap-2">
                              <Switch checked={b.hourFilter !== null} onCheckedChange={v => updateBadge(b.id, "hourFilter", v ? { start: 11, end: 13 } : null)} />
                              {b.hourFilter && (
                                <>
                                  <Input type="number" value={b.hourFilter.start} onChange={e => updateBadge(b.id, "hourFilter", { ...b.hourFilter!, start: Number(e.target.value) })} className="h-8 text-xs w-20" />
                                  <span className="text-muted-foreground">to</span>
                                  <Input type="number" value={b.hourFilter.end} onChange={e => updateBadge(b.id, "hourFilter", { ...b.hourFilter!, end: Number(e.target.value) })} className="h-8 text-xs w-20" />
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Scope & Reward */}
                        <div className="rounded-lg p-3" style={{ background: "rgba(255,255,255,0.02)" }}>
                          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Scope, Reward & Shift Team</div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <FieldLabel>Competition Scope</FieldLabel>
                              <select value={b.scope} onChange={e => updateBadge(b.id, "scope", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {SCOPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                            <div>
                              <FieldLabel>Reward Goes To</FieldLabel>
                              <select value={b.rewardTarget} onChange={e => updateBadge(b.id, "rewardTarget", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {REWARD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </div>
                            <div><FieldLabel>Cooldown</FieldLabel><Input type="number" value={b.cooldown} onChange={e => updateBadge(b.id, "cooldown", Number(e.target.value))} className="h-8 text-xs" /></div>
                          </div>
                          {(b.rewardTarget === "shift_team" || b.rewardTarget === "both") && (
                            <div className="mt-3 rounded-md p-3" style={{ background: `${ORANGE}08`, border: `1px solid ${ORANGE}20` }}>
                              <div className="text-[10px] font-bold mb-1.5" style={{ color: ORANGE }}>MULTI-LEADER SHIFT HANDLING</div>
                              <select value={b.shiftCrewMode} onChange={e => updateBadge(b.id, "shiftCrewMode", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white mb-1.5" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                                {SHIFT_CREW_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                              <div className="text-muted-foreground text-[10px] leading-relaxed">
                                {b.shiftCrewMode === "all_leaders" && "Every clocked-in leader gets individual credit for this badge."}
                                {b.shiftCrewMode === "primary_leader" && "The Manager gets primary credit. Shift Supervisors are noted but don't earn individually."}
                                {b.shiftCrewMode === "shift_team_named" && "The entire leadership team is credited as a group (e.g. 'Cullman Lunch Crew — Marcus J. & Tyrell H.')."}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      /* ── COLLAPSED VIEW ── */
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <BadgeIcon badge={b} size={32} config={cfg} />
                          <div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-white font-semibold text-sm">{b.name}</span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: "#555", background: "rgba(255,255,255,0.06)" }}>{b.tier}</span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: ORANGE, background: `${ORANGE}10` }}>{b.evalFrequency.replace("end_of_", "")}</span>
                              <span className="text-[9px] px-1.5 py-0.5 rounded" style={{ color: "#3b82f6", background: "rgba(59,130,246,0.1)" }}>→ {b.rewardTarget === "shift_team" ? "team" : b.rewardTarget}</span>
                            </div>
                            <div className="text-muted-foreground text-[11px] mt-0.5">{b.desc}</div>
                            <div className="flex gap-1 mt-0.5 flex-wrap items-center">
                              <span className="text-muted-foreground text-[9px] font-mono">{b.metric} {b.operator} {b.threshold}</span>
                              {b.windowDays.length > 0 && <span className="text-muted-foreground text-[9px]">· {b.windowDays.map(d => DAY_LABELS[d]).join(",")}{b.requireAllDays ? " (ALL)" : ""}</span>}
                              {b.hourFilter && <span className="text-muted-foreground text-[9px]">· {b.hourFilter.start}-{b.hourFilter.end}:00</span>}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch checked={b.active} onCheckedChange={v => updateBadge(b.id, "active", v)} />
                          <button onClick={() => setEditingBadge(b.id)} className="px-2.5 py-1 rounded text-[10px] cursor-pointer" style={{ border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#aaa" }}>Edit</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ── SHIFT TEAMS ── */}
            {settingsTab === "shiftTeam" && (
              <div>
                <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: ORANGE }}>Shift Team Configuration</div>
                  <p className="text-muted-foreground text-xs mb-4 leading-relaxed">When multiple leaders are on the same shift, this controls how they're credited for team-earned badges.</p>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <FieldLabel>Default Crew Mode</FieldLabel>
                      <select value={cfg.shiftTeamConfig.defaultCrewMode} onChange={e => updateConfig("shiftTeamConfig.defaultCrewMode", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                        {SHIFT_CREW_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <FieldLabel>Display Format</FieldLabel>
                      <select value={cfg.shiftTeamConfig.displayFormat} onChange={e => updateConfig("shiftTeamConfig.displayFormat", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                        <option value="team_named">Named team</option>
                        <option value="individual_list">Individual list</option>
                        <option value="primary_plus">Primary + others</option>
                      </select>
                    </div>
                  </div>
                  <div>
                    <FieldLabel>Team Name Template</FieldLabel>
                    <Input value={cfg.shiftTeamConfig.teamNameTemplate} onChange={e => updateConfig("shiftTeamConfig.teamNameTemplate", e.target.value)} className="h-8 text-xs" />
                    <div className="text-muted-foreground text-[10px] mt-1">Variables: {"{store} {shift_type} {date} {primary_leader} {team_count}"}</div>
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Role Hierarchy (highest to lowest)</div>
                  {cfg.shiftTeamConfig.roleHierarchy.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 mb-1.5">
                      <span className="font-bold font-mono text-xs w-5" style={{ color: ORANGE }}>{i + 1}.</span>
                      <Input value={r} onChange={e => { const n = [...cfg.shiftTeamConfig.roleHierarchy]; n[i] = e.target.value; updateConfig("shiftTeamConfig.roleHierarchy", n); }} className="h-8 text-xs" />
                    </div>
                  ))}
                  <button onClick={() => updateConfig("shiftTeamConfig.roleHierarchy", [...cfg.shiftTeamConfig.roleHierarchy, ""])}
                    className="px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer mt-1" style={{ border: `1px dashed ${ORANGE}`, background: "transparent", color: ORANGE }}>+ Add Role</button>
                </div>
              </div>
            )}

            {/* ── STREAKS ── */}
            {settingsTab === "streaks" && (
              <div>
                <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Streak Rules</div>
                  <div className="grid grid-cols-4 gap-2 mb-3">
                    <div>
                      <FieldLabel>Min Grade</FieldLabel>
                      <select value={cfg.streakConfig.minGrade} onChange={e => updateConfig("streakConfig.minGrade", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                        {["A+", "A", "B", "C"].map(g => <option key={g} value={g}>{g}</option>)}
                      </select>
                    </div>
                    <div>
                      <FieldLabel>Track By</FieldLabel>
                      <select value={cfg.streakConfig.trackBy} onChange={e => updateConfig("streakConfig.trackBy", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                        <option value="leader">Leaders</option><option value="unit">Units</option><option value="both">Both</option>
                      </select>
                    </div>
                    <div>
                      <FieldLabel>Reset On</FieldLabel>
                      <select value={cfg.streakConfig.resetOn} onChange={e => updateConfig("streakConfig.resetOn", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                        <option value="below_threshold">Below min grade</option><option value="any_below_b">Below B</option><option value="grade_f">Only on F</option>
                      </select>
                    </div>
                    <div>
                      <FieldLabel>Week Start</FieldLabel>
                      <select value={cfg.fiscalWeekStart} onChange={e => updateConfig("fiscalWeekStart", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                        {DAYS.map(d => <option key={d} value={d}>{DAY_LABELS[d]}</option>)}
                      </select>
                    </div>
                  </div>
                  <DayPicker label="Streak counts these days" selected={cfg.streakConfig.weekDefinition} onChange={v => updateConfig("streakConfig.weekDefinition", v)} />
                </div>

                <div className="flex justify-between items-center mb-3">
                  <span className="text-white text-sm font-semibold">Streak Milestones</span>
                  <button onClick={() => {
                    const n = JSON.parse(JSON.stringify(cfg));
                    n.streakConfig.milestones.push({ days: 21, name: "New Milestone", icon: "🎯", tier: "silver", notify: true, rewardTarget: "leader" });
                    setCfg(n); setDirty(true);
                  }} className="px-3 py-1.5 rounded text-[11px] font-semibold cursor-pointer" style={{ border: `1px dashed ${ORANGE}`, background: "transparent", color: ORANGE }}>+ Add</button>
                </div>
                {cfg.streakConfig.milestones.map((m, i) => (
                  <div key={i} className="rounded-xl p-3 mb-1.5" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    <div className="grid items-end gap-2" style={{ gridTemplateColumns: "50px 1fr 100px 70px 110px 60px 40px" }}>
                      <div><FieldLabel>Icon</FieldLabel><Input value={m.icon} onChange={e => updateMilestone(i, "icon", e.target.value)} className="h-8 text-xs" /></div>
                      <div><FieldLabel>Name</FieldLabel><Input value={m.name} onChange={e => updateMilestone(i, "name", e.target.value)} className="h-8 text-xs" /></div>
                      <div>
                        <FieldLabel>Tier</FieldLabel>
                        <select value={m.tier} onChange={e => updateMilestone(i, "tier", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                          {["bronze", "silver", "gold", "platinum", "orange"].map(t => <option key={t} value={t}>{t}</option>)}
                        </select>
                      </div>
                      <div><FieldLabel>Days</FieldLabel><Input type="number" value={m.days} onChange={e => updateMilestone(i, "days", Number(e.target.value))} className="h-8 text-xs" /></div>
                      <div>
                        <FieldLabel>Reward</FieldLabel>
                        <select value={m.rewardTarget} onChange={e => updateMilestone(i, "rewardTarget", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                          {REWARD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <FieldLabel>Notify</FieldLabel>
                        <Switch checked={m.notify} onCheckedChange={v => updateMilestone(i, "notify", v)} />
                      </div>
                      <button onClick={() => { const n = JSON.parse(JSON.stringify(cfg)); n.streakConfig.milestones.splice(i, 1); setCfg(n); setDirty(true); }}
                        className="p-1 rounded text-[10px] cursor-pointer self-end" style={{ border: "1px solid #ef444440", background: "transparent", color: "#ef4444" }}>✕</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* ── NOTIFICATIONS ── */}
            {settingsTab === "notifications" && (
              <div>
                <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Delivery Channels</div>
                  <div className="flex gap-6">
                    <div className="flex items-center gap-2">
                      <Switch checked={cfg.notifications.channels.email} onCheckedChange={v => updateConfig("notifications.channels.email", v)} />
                      <span className="text-muted-foreground text-xs">Email (Resend)</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={cfg.notifications.channels.sms} onCheckedChange={v => updateConfig("notifications.channels.sms", v)} />
                      <span className="text-muted-foreground text-xs">SMS</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={cfg.notifications.channels.slack} onCheckedChange={v => updateConfig("notifications.channels.slack", v)} />
                      <span className="text-muted-foreground text-xs">Slack</span>
                    </div>
                  </div>
                </div>

                {cfg.notifications.autoMessages.map(n => (
                  <div key={n.id} className="rounded-xl p-3 mb-1.5" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                    {editingNotif === n.id ? (
                      <div>
                        <div className="flex justify-between mb-2">
                          <span className="text-[10px] font-bold uppercase" style={{ color: ORANGE }}>Editing</span>
                          <button onClick={() => setEditingNotif(null)} className="px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer border-none text-white" style={{ background: ORANGE }}>Done</button>
                        </div>
                        <div className="grid grid-cols-2 gap-2 mb-2">
                          <div>
                            <FieldLabel>Trigger</FieldLabel>
                            <select value={n.trigger} onChange={e => updateNotif(n.id, "trigger", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                              {["badge_earned", "team_badge_earned", "streak_milestone", "record_broken", "streak_broken", "daily_eod"].map(t => <option key={t} value={t}>{t}</option>)}
                            </select>
                          </div>
                          <div>
                            <FieldLabel>Recipients</FieldLabel>
                            <select value={n.recipients} onChange={e => updateNotif(n.id, "recipients", e.target.value)} className="w-full h-8 px-2 rounded border text-xs text-white" style={{ background: "rgba(255,255,255,0.06)", borderColor: "rgba(255,255,255,0.15)" }}>
                              {Object.keys(cfg.notifications.recipientGroups).map(k => <option key={k} value={k}>{k}</option>)}
                            </select>
                          </div>
                        </div>
                        <FieldLabel>Template</FieldLabel>
                        <Input value={n.template} onChange={e => updateNotif(n.id, "template", e.target.value)} className="h-8 text-xs" />
                        <div className="text-muted-foreground text-[9px] mt-1">Vars: {"{leader_name} {team_names} {store} {badge_name} {badge_desc} {streak_days} {milestone_name}"}</div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-white font-semibold text-xs">{n.trigger.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}</span>
                            <span className="text-muted-foreground text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)" }}>→ {n.recipients}</span>
                          </div>
                          <div className="text-muted-foreground text-[10px] mt-1 italic">{n.template.substring(0, 90)}...</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch checked={n.enabled} onCheckedChange={v => updateNotif(n.id, "enabled", v)} />
                          <button onClick={() => setEditingNotif(n.id)} className="px-2.5 py-1 rounded text-[10px] cursor-pointer" style={{ border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#aaa" }}>Edit</button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* ── GRADES & TIMING ── */}
            {settingsTab === "thresholds" && (
              <div>
                <div className="rounded-xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Grade Thresholds</div>
                  <div className="grid grid-cols-6 gap-2">
                    {Object.entries(cfg.gradeThresholds).map(([g, v]) => (
                      <div key={g}>
                        <GradeChip grade={g} />
                        <div className="mt-1.5">
                          <FieldLabel>Min</FieldLabel>
                          <Input type="number" value={v} onChange={e => updateConfig(`gradeThresholds.${g}`, Number(e.target.value))} className="h-8 text-xs" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-3">Peak Hour Windows</div>
                  {cfg.peakHours.map((ph, i) => (
                    <div key={i} className="grid items-end gap-2 mb-1.5" style={{ gridTemplateColumns: "1fr 80px 80px 40px" }}>
                      <div><FieldLabel>Name</FieldLabel><Input value={ph.name} onChange={e => { const n = [...cfg.peakHours]; n[i] = { ...n[i], name: e.target.value }; updateConfig("peakHours", n); }} className="h-8 text-xs" /></div>
                      <div><FieldLabel>Start</FieldLabel><Input type="number" value={ph.start} onChange={e => { const n = [...cfg.peakHours]; n[i] = { ...n[i], start: Number(e.target.value) }; updateConfig("peakHours", n); }} className="h-8 text-xs" /></div>
                      <div><FieldLabel>End</FieldLabel><Input type="number" value={ph.end} onChange={e => { const n = [...cfg.peakHours]; n[i] = { ...n[i], end: Number(e.target.value) }; updateConfig("peakHours", n); }} className="h-8 text-xs" /></div>
                      <button onClick={() => updateConfig("peakHours", cfg.peakHours.filter((_, j) => j !== i))}
                        className="p-1 rounded text-[10px] cursor-pointer self-end" style={{ border: "1px solid #ef444440", background: "transparent", color: "#ef4444" }}>✕</button>
                    </div>
                  ))}
                  <button onClick={() => updateConfig("peakHours", [...cfg.peakHours, { name: "New Window", start: 8, end: 10 }])}
                    className="px-2.5 py-1 rounded text-[10px] font-semibold cursor-pointer mt-1" style={{ border: `1px dashed ${ORANGE}`, background: "transparent", color: ORANGE }}>+ Add</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── FOOTER ─── */}
      <div className="px-5 py-2.5 mt-6 flex justify-between" style={{ background: "#757070" }}>
        <span className="text-[10px]" style={{ color: "#bbb" }}>MWB Restaurants LLC · Performance Arena v1</span>
        <span className="text-[10px]" style={{ color: "#bbb" }}>Pride · Care · Love</span>
      </div>

      {/* Select option styling for dark background */}
      <style>{`select option { background: #222; color: #fff; }`}</style>
    </div>
  );
}
