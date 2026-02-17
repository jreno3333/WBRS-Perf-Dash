import { useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Mail, CheckCircle, AlertCircle, Loader2 } from "lucide-react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "sent" | "error">("idle");
  const [, setLocation] = useLocation();

  const params = new URLSearchParams(window.location.search);
  const errorParam = params.get("error");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;

    setStatus("loading");
    try {
      const res = await fetch("/api/auth/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.ok) {
        setStatus("sent");
      } else {
        setStatus("error");
      }
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl" data-testid="text-login-title">MWB Dashboard</CardTitle>
          <p className="text-sm text-muted-foreground mt-1">Sign in with your email</p>
        </CardHeader>
        <CardContent>
          {errorParam && status === "idle" && (
            <div className="flex items-center gap-2 p-3 mb-4 rounded-md bg-destructive/10 text-destructive text-sm" data-testid="text-login-error">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>
                {errorParam === "expired" ? "That link has expired. Please request a new one." :
                 errorParam === "invalid" ? "That link is invalid. Please try again." :
                 errorParam === "deactivated" ? "Your account has been deactivated. Contact an administrator for access." :
                 "Something went wrong. Please try again."}
              </span>
            </div>
          )}

          {status === "sent" ? (
            <div className="flex flex-col items-center gap-3 py-4" data-testid="text-check-email">
              <CheckCircle className="h-10 w-10 text-green-500" />
              <p className="text-center font-medium">Check your email</p>
              <p className="text-sm text-muted-foreground text-center">
                We sent a sign-in link to <span className="font-medium">{email}</span>
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="mt-2"
                onClick={() => { setStatus("idle"); setEmail(""); }}
                data-testid="button-try-different"
              >
                Use a different email
              </Button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-9"
                  required
                  disabled={status === "loading"}
                  data-testid="input-email"
                />
              </div>
              <Button
                type="submit"
                className="w-full"
                disabled={status === "loading" || !email.trim()}
                data-testid="button-send-link"
              >
                {status === "loading" ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Sending...</>
                ) : (
                  "Send Sign-In Link"
                )}
              </Button>
              {status === "error" && (
                <p className="text-sm text-destructive text-center" data-testid="text-send-error">
                  Failed to send. Please try again.
                </p>
              )}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
