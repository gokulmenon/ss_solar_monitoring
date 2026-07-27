"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Github, Loader2, ShieldCheck, Sparkles } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type Provider = "google" | "github";

const providerLabels: Record<Provider, string> = {
  google: "Google",
  github: "GitHub",
};

export function LoginPageClient() {
  const searchParams = useSearchParams();
  const routeError = searchParams.get("error");
  const [inviteCode, setInviteCode] = useState("");
  const [errorMsg, setErrorMsg] = useState(routeError ?? "");
  const [loadingProvider, setLoadingProvider] = useState<Provider | null>(null);

  const normalizedInviteCode = useMemo(() => inviteCode.trim().toUpperCase(), [inviteCode]);
  const canStartSignup = normalizedInviteCode.length > 0;

  const startOAuth = async (provider: Provider, inviteCodeToUse = "") => {
    setErrorMsg("");
    setLoadingProvider(provider);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          provider,
          inviteCode: inviteCodeToUse,
        }),
      });

      const payload = (await response.json()) as { url?: string; error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Failed to start login.");
      }

      if (!payload.url) {
        throw new Error("Missing OAuth redirect URL.");
      }

      window.location.assign(payload.url);
    } catch (error) {
      setErrorMsg(error instanceof Error ? error.message : "Failed to start login.");
      setLoadingProvider(null);
    }
  };

  return (
    <div className="relative overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-56 rounded-full bg-sky-500/10 blur-3xl" />
      <div className="pointer-events-none absolute right-0 top-24 h-44 w-44 rounded-full bg-amber-400/10 blur-3xl" />

      <div className="relative space-y-6">
        <div className="space-y-3 text-center sm:text-left">
          <p className="inline-flex items-center gap-2 rounded-full border border-sky-400/20 bg-sky-400/10 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.24em] text-sky-100">
            <Sparkles className="h-3.5 w-3.5" />
            Invite-only access
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50 sm:text-4xl">
            Sign in to Solar Monitor
          </h1>
          <p className="max-w-xl text-sm leading-6 text-slate-400 sm:text-base">
            Returning users can log in right away. New users need an invite code before we start
            OAuth.
          </p>
        </div>

        <Card className="border-white/10 bg-slate-950/75">
          <CardHeader>
            <CardTitle className="text-base">Already have an account?</CardTitle>
            <CardDescription>
              Log in with Google or GitHub and we’ll take you straight into your existing account.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {errorMsg ? (
              <div className="rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-100">
                {errorMsg}
              </div>
            ) : null}

            <div className="grid gap-3">
              <Button
                type="button"
                className="w-full"
                disabled={loadingProvider !== null}
                onClick={() => startOAuth("google")}
              >
                {loadingProvider === "google" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Log in with {providerLabels.google}
              </Button>

              <Button
                type="button"
                variant="secondary"
                className="w-full"
                disabled={loadingProvider !== null}
                onClick={() => startOAuth("github")}
              >
                {loadingProvider === "github" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Github className="h-4 w-4" />
                )}
                Log in with {providerLabels.github}
              </Button>
            </div>

            <div className="border-t border-white/10 pt-4">
              <div className="space-y-3">
                <div className="space-y-1">
                  <h2 className="text-base font-medium text-slate-100">
                    New here?
                  </h2>
                  <p className="text-sm leading-6 text-slate-400">
                    Enter your invite code first, then create your account with Google or GitHub.
                  </p>
                </div>

                <div className="space-y-2">
                  <label htmlFor="invite-code" className="text-sm font-medium text-slate-200">
                    Invite code
                  </label>
                  <input
                    id="invite-code"
                    type="text"
                    autoCapitalize="characters"
                    spellCheck={false}
                    autoComplete="one-time-code"
                    placeholder="SOLAR-SECRET-2026"
                    value={inviteCode}
                    onChange={(event) => setInviteCode(event.target.value)}
                    className="h-12 w-full rounded-2xl border border-white/10 bg-white/[0.04] px-4 text-sm text-slate-50 placeholder:text-slate-500 outline-none transition focus:border-sky-400/40 focus:ring-2 focus:ring-sky-400/20"
                  />
                  <p className="text-xs leading-5 text-slate-500">
                    We keep the invite code in an HTTP-only cookie only long enough to finish the
                    OAuth callback.
                  </p>
                </div>

                <div className="grid gap-3">
                  <Button
                    type="button"
                    className="w-full"
                    disabled={loadingProvider !== null || !canStartSignup}
                    onClick={() => startOAuth("google", normalizedInviteCode)}
                  >
                    {loadingProvider === "google" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Create account with {providerLabels.google}
                  </Button>

                  <Button
                    type="button"
                    variant="secondary"
                    className="w-full"
                    disabled={loadingProvider !== null || !canStartSignup}
                    onClick={() => startOAuth("github", normalizedInviteCode)}
                  >
                    {loadingProvider === "github" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Github className="h-4 w-4" />
                    )}
                    Create account with {providerLabels.github}
                  </Button>
                </div>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-2xl border border-emerald-400/15 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-50">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="leading-6">
                Unauthorized new accounts are removed in the callback before they can reach the app.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
