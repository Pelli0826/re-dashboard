import { useState } from "react";
import { Loader2, Lock, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

interface LoginProps {
  onLogin: () => void;
  locked?: boolean;
}

export default function Login({ onLogin, locked }: LoginProps) {
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        onLogin();
      } else {
        const data = await res.json();
        setError(data.message ?? "Incorrect password");
      }
    } catch {
      setError("Could not connect to server");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8 gap-3">
          <div className="flex items-center gap-2.5">
            <svg aria-label="RE Dashboard" viewBox="0 0 32 32" width="36" height="36" fill="none" className="text-primary">
              <rect x="2" y="14" width="10" height="16" rx="1" fill="currentColor" opacity="0.85"/>
              <rect x="14" y="8" width="16" height="22" rx="1" fill="currentColor"/>
              <path d="M16 2 L30 8 L30 6 L16 0 L2 6 L2 8 Z" fill="currentColor" opacity="0.6"/>
            </svg>
            <div>
              <div className="text-base font-bold tracking-wide text-foreground">RE Dashboard</div>
              <div className="text-xs text-muted-foreground">Developer HQ</div>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Lock size={15} className="text-primary" /> Sign In
            </CardTitle>
            <CardDescription className="text-xs">Enter your password to access the dashboard</CardDescription>
          </CardHeader>
          <CardContent>
            {locked && (
              <p role="alert" className="mb-4 text-sm rounded-md bg-amber-50 dark:bg-amber-900/20 text-amber-900 dark:text-amber-200 px-3 py-2">
                Sign-in is turned off because no password has been set. In Railway, add a DASHBOARD_PASSWORD variable to this service; it redeploys automatically.
              </p>
            )}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label className="text-xs text-muted-foreground mb-1.5 block">Password</Label>
                <Input
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter password"
                  autoFocus
                  data-testid="input-password"
                  className="h-10"
                />
              </div>

              {error && (
                <p className="text-sm text-red-500 flex items-center gap-1.5">
                  <span>⚠</span> {error}
                </p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={loading || !password}
                data-testid="button-login"
              >
                {loading ? <Loader2 className="animate-spin mr-2" size={14} /> : null}
                {loading ? "Signing in…" : "Sign In"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-center text-xs text-muted-foreground mt-6">
          Created with Perplexity Computer
        </p>
      </div>
    </div>
  );
}
