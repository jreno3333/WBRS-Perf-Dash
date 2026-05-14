import { useState, useRef, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  FileText,
  Printer,
  Share2,
  Link2,
  Mail,
  Check,
  Copy,
  Loader2,
  Eye,
  GraduationCap,
  Award,
  ArrowUpDown,
} from "lucide-react";

interface TrainingUnitCertification {
  key: string;
  name: string;
  earnedAt: string | null;
  expiresAt: string | null;
}
interface TrainingUnitEmployee {
  employeeId: string;
  name: string;
  position: string | null;
  type: string | null;
  percentComplete: number;
  totalCourses: number;
  completedCourses: number;
  overdueCourses: number;
  inProgressCourses: number;
  certifications: TrainingUnitCertification[];
  hasFiveStarFloor: boolean;
}
interface TrainingUnitRollup {
  employeeCount: number;
  employeesWithProgress: number;
  avgPercentComplete: number;
  completedCourses: number;
  overdueCourses: number;
  certifiedShiftPlusCount: number;
  certifiedShiftPlusTotal: number;
}
interface TrainingUnitResponse {
  restaurantId: string;
  rollup: TrainingUnitRollup | null;
  employees: TrainingUnitEmployee[];
}
type TrainingSortKey = "name" | "percentComplete" | "overdueCourses" | "totalCourses";

interface UnitReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restaurantId: string;
  restaurantName: string;
  date: string;
}

export function UnitReportDialog({
  open,
  onOpenChange,
  restaurantId,
  restaurantName,
  date,
}: UnitReportDialogProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"preview" | "training" | "share">("preview");
  const [trainingSort, setTrainingSort] = useState<TrainingSortKey>("percentComplete");
  const [trainingSortDir, setTrainingSortDir] = useState<"asc" | "desc">("asc");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [isGeneratingLink, setIsGeneratingLink] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const [emailTo, setEmailTo] = useState("");
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const previewUrl = `/api/push-report/preview?date=${date}&unit=${restaurantId}`;

  const { data: trainingUnit, isLoading: trainingLoading } = useQuery<TrainingUnitResponse>({
    queryKey: ["/api/training/unit", restaurantId],
    queryFn: async () => {
      const res = await fetch(`/api/training/unit/${restaurantId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load unit training");
      return res.json();
    },
    enabled: open && activeTab === "training",
    staleTime: 5 * 60 * 1000,
  });

  const sortedTrainingEmployees = useMemo(() => {
    const list = [...(trainingUnit?.employees || [])];
    const dir = trainingSortDir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      switch (trainingSort) {
        case "name":
          return a.name.localeCompare(b.name) * dir;
        case "percentComplete":
          return (a.percentComplete - b.percentComplete) * dir;
        case "overdueCourses":
          return (a.overdueCourses - b.overdueCourses) * dir;
        case "totalCourses":
          return (a.totalCourses - b.totalCourses) * dir;
      }
    });
    return list;
  }, [trainingUnit, trainingSort, trainingSortDir]);

  const handleTrainingSort = useCallback((key: TrainingSortKey) => {
    setTrainingSort((prev) => {
      if (prev === key) {
        setTrainingSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setTrainingSortDir(key === "name" ? "asc" : "desc");
      return key;
    });
  }, []);

  const formattedDate = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${date}T12:00:00`));

  const handlePrint = useCallback(() => {
    const iframe = iframeRef.current;
    if (iframe?.contentWindow) {
      iframe.contentWindow.print();
    } else {
      // Fallback: open in new tab for printing
      window.open(previewUrl, "_blank");
    }
  }, [previewUrl]);

  const handleGenerateShareLink = useCallback(async () => {
    setIsGeneratingLink(true);
    try {
      const response = await fetch("/api/push-report/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ date, restaurantId }),
      });

      if (!response.ok) throw new Error("Failed to generate share link");

      const data = await response.json();
      setShareUrl(data.url);
      toast({
        title: data.existing ? "Share link retrieved" : "Share link created",
        description: "Link is ready to copy or send.",
      });
    } catch {
      toast({
        title: "Error",
        description: "Failed to generate share link. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingLink(false);
    }
  }, [date, restaurantId, toast]);

  const handleCopyLink = useCallback(async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setIsCopied(true);
      toast({ title: "Copied!", description: "Link copied to clipboard." });
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const input = document.createElement("input");
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      document.body.removeChild(input);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  }, [shareUrl, toast]);

  const handleSendEmail = useCallback(async () => {
    if (!emailTo.trim()) return;
    setIsSendingEmail(true);
    try {
      const response = await fetch("/api/push-report/send-unit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ date, restaurantId, email: emailTo.trim() }),
      });

      if (!response.ok) throw new Error("Failed to send report");

      const data = await response.json();
      if (data.success) {
        toast({
          title: "Report sent!",
          description: `Unit report sent to ${emailTo.trim()}`,
        });
        setEmailTo("");
      } else {
        throw new Error("Send failed");
      }
    } catch {
      toast({
        title: "Error",
        description: "Failed to send report. Check email configuration.",
        variant: "destructive",
      });
    } finally {
      setIsSendingEmail(false);
    }
  }, [date, restaurantId, emailTo, toast]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-blue-500" />
            Unit Report: {restaurantName}
          </DialogTitle>
          <DialogDescription>{formattedDate}</DialogDescription>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex gap-1 border-b pb-1">
          <Button
            variant={activeTab === "preview" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("preview")}
            className="gap-1.5"
          >
            <Eye className="w-3.5 h-3.5" />
            Preview
          </Button>
          <Button
            variant={activeTab === "training" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("training")}
            className="gap-1.5"
            data-testid="tab-training"
          >
            <GraduationCap className="w-3.5 h-3.5" />
            Training
          </Button>
          <Button
            variant={activeTab === "share" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTab("share")}
            className="gap-1.5"
          >
            <Share2 className="w-3.5 h-3.5" />
            Share
          </Button>
        </div>

        {activeTab === "training" && (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden" data-testid="unit-training-section">
            {trainingLoading ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : !trainingUnit || trainingUnit.employees.length === 0 ? (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                No training data synced for this unit yet.
              </div>
            ) : (
              <div className="flex-1 flex flex-col min-h-0 overflow-y-auto pr-1">
                {trainingUnit.rollup && (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3" data-testid="training-rollup-summary">
                    {(() => {
                      const r = trainingUnit.rollup;
                      const pct = r.avgPercentComplete;
                      const pctColor = pct >= 90 ? "text-green-600" : pct >= 70 ? "text-amber-600" : "text-red-500";
                      return (
                        <>
                          <div className="p-2 rounded-md bg-muted/50">
                            <div className="text-[10px] uppercase text-muted-foreground">Avg %</div>
                            <div className={`text-base font-semibold ${pctColor}`} data-testid="text-rollup-pct">{pct.toFixed(1)}%</div>
                          </div>
                          <div className="p-2 rounded-md bg-muted/50">
                            <div className="text-[10px] uppercase text-muted-foreground">Completed</div>
                            <div className="text-base font-semibold">{r.completedCourses}</div>
                          </div>
                          <div className="p-2 rounded-md bg-muted/50">
                            <div className="text-[10px] uppercase text-muted-foreground">Overdue</div>
                            <div className={`text-base font-semibold ${r.overdueCourses > 0 ? "text-red-500" : ""}`} data-testid="text-rollup-overdue">{r.overdueCourses}</div>
                          </div>
                          <div className="p-2 rounded-md bg-muted/50">
                            <div className="text-[10px] uppercase text-muted-foreground">5-Star Shift+</div>
                            <div className="text-base font-semibold">{r.certifiedShiftPlusCount} / {r.certifiedShiftPlusTotal}</div>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                )}

                <div className="grid grid-cols-[1fr_60px_60px_70px_1fr] gap-2 px-2 py-1 text-[10px] uppercase text-muted-foreground border-b">
                  <button
                    type="button"
                    onClick={() => handleTrainingSort("name")}
                    className="flex items-center gap-1 text-left hover:text-foreground"
                    data-testid="sort-name"
                  >
                    Employee <ArrowUpDown className="w-2.5 h-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTrainingSort("percentComplete")}
                    className="flex items-center gap-1 justify-end hover:text-foreground"
                    data-testid="sort-percent"
                  >
                    %
                    <ArrowUpDown className="w-2.5 h-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTrainingSort("totalCourses")}
                    className="flex items-center gap-1 justify-end hover:text-foreground"
                    data-testid="sort-total"
                  >
                    Done
                    <ArrowUpDown className="w-2.5 h-2.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleTrainingSort("overdueCourses")}
                    className="flex items-center gap-1 justify-end hover:text-foreground"
                    data-testid="sort-overdue"
                  >
                    Overdue
                    <ArrowUpDown className="w-2.5 h-2.5" />
                  </button>
                  <span className="text-right">Certs</span>
                </div>

                <div className="divide-y">
                  {sortedTrainingEmployees.map((emp) => {
                    const pct = emp.percentComplete;
                    const pctColor = emp.totalCourses === 0
                      ? "text-muted-foreground"
                      : pct >= 90 ? "text-green-600" : pct >= 70 ? "text-amber-600" : "text-red-500";
                    return (
                      <div
                        key={emp.employeeId}
                        className="grid grid-cols-[1fr_60px_60px_70px_1fr] gap-2 px-2 py-1.5 text-xs items-center"
                        data-testid={`row-training-${emp.employeeId}`}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-medium">{emp.name || emp.employeeId}</div>
                          {emp.position && (
                            <div className="text-[10px] text-muted-foreground truncate">{emp.position}</div>
                          )}
                        </div>
                        <div className={`text-right font-semibold ${pctColor}`} data-testid={`text-pct-${emp.employeeId}`}>
                          {emp.totalCourses === 0 ? "--" : `${pct.toFixed(0)}%`}
                        </div>
                        <div className="text-right text-muted-foreground">
                          {emp.completedCourses} / {emp.totalCourses}
                        </div>
                        <div className={`text-right font-medium ${emp.overdueCourses > 0 ? "text-red-500" : "text-muted-foreground"}`} data-testid={`text-overdue-${emp.employeeId}`}>
                          {emp.overdueCourses}
                        </div>
                        <div className="flex flex-wrap gap-1 justify-end">
                          {emp.certifications.slice(0, 3).map((c) => (
                            <Badge
                              key={c.key}
                              className="text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-300 border-0 gap-0.5"
                              data-testid={`badge-cert-${emp.employeeId}-${c.key}`}
                            >
                              <Award className="w-2.5 h-2.5" />
                              {c.name}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Preview Tab */}
        {activeTab === "preview" && (
          <div className="flex-1 flex flex-col min-h-0">
            <div className="flex-1 border rounded-md overflow-hidden min-h-[400px]">
              <iframe
                ref={iframeRef}
                src={previewUrl}
                className="w-full h-full min-h-[400px]"
                title="Report Preview"
                style={{ border: "none" }}
              />
            </div>
            <div className="flex items-center gap-2 pt-3">
              <Button onClick={handlePrint} className="gap-1.5">
                <Printer className="w-4 h-4" />
                Print / Save PDF
              </Button>
              <Button
                variant="outline"
                onClick={() => window.open(previewUrl, "_blank")}
                className="gap-1.5"
              >
                <Eye className="w-4 h-4" />
                Open Full Page
              </Button>
            </div>
          </div>
        )}

        {/* Share Tab */}
        {activeTab === "share" && (
          <div className="space-y-4">
            {/* Generate Share Link */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium flex items-center gap-1.5">
                <Link2 className="w-4 h-4 text-blue-500" />
                Share via Link
              </h4>
              <p className="text-xs text-muted-foreground">
                Generate a public link that anyone can view without logging in.
              </p>
              {!shareUrl ? (
                <Button
                  onClick={handleGenerateShareLink}
                  disabled={isGeneratingLink}
                  variant="outline"
                  className="gap-1.5"
                >
                  {isGeneratingLink ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Link2 className="w-4 h-4" />
                  )}
                  Generate Share Link
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <Input
                    value={shareUrl}
                    readOnly
                    className="flex-1 text-xs font-mono"
                  />
                  <Button
                    onClick={handleCopyLink}
                    variant="outline"
                    size="sm"
                    className="gap-1 shrink-0"
                  >
                    {isCopied ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                    {isCopied ? "Copied" : "Copy"}
                  </Button>
                </div>
              )}
            </div>

            <div className="border-t pt-4 space-y-2">
              <h4 className="text-sm font-medium flex items-center gap-1.5">
                <Mail className="w-4 h-4 text-blue-500" />
                Send via Email
              </h4>
              <p className="text-xs text-muted-foreground">
                Send this unit's report directly to an email address.
              </p>
              <div className="flex items-center gap-2">
                <Input
                  type="email"
                  placeholder="email@example.com"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  className="flex-1"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSendEmail();
                  }}
                />
                <Button
                  onClick={handleSendEmail}
                  disabled={isSendingEmail || !emailTo.trim()}
                  className="gap-1.5 shrink-0"
                >
                  {isSendingEmail ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Mail className="w-4 h-4" />
                  )}
                  Send
                </Button>
              </div>
            </div>

            {shareUrl && (
              <div className="border-t pt-3">
                <Badge variant="outline" className="text-xs gap-1">
                  <Check className="w-3 h-3 text-green-500" />
                  Share link active
                </Badge>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
