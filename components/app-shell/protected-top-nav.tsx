"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { ChartArea, Home, LogOut, Settings2, Zap } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useLiveTelemetry } from "@/components/telemetry/use-live-telemetry";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

const tabs = [
  {
    href: "/home",
    label: "Home",
    icon: Home,
  },
  {
    href: "/live",
    label: "Live",
    icon: Zap,
  },
  {
    href: "/history",
    label: "History",
    icon: ChartArea,
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings2,
  },
] as const;

function formatTimestamp(timestamp: string | undefined) {
  if (!timestamp) return "Awaiting update";

  return new Date(timestamp).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ProtectedTopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const { telemetry } = useLiveTelemetry();

  const handleSignOut = async () => {
    setIsSigningOut(true);

    try {
      const supabase = createClient();
      await supabase.auth.signOut();
    } finally {
      router.replace("/login");
      router.refresh();
      setIsSigningOut(false);
    }
  };

  return (
    <header className="sticky top-0 z-40 mb-4 rounded-b-[1.75rem] border border-white/10 bg-slate-950/80 px-4 pb-4 pt-[calc(0.75rem+env(safe-area-inset-top))] shadow-2xl shadow-slate-950/30 backdrop-blur-2xl">
      <div className="flex items-center gap-3">
        <Link
          href="/home"
          aria-label="Go to home dashboard"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.04] text-slate-100 transition hover:bg-white/[0.08]"
        >
          <Home className="h-5 w-5" />
        </Link>

        <p className="min-w-0 flex-1 truncate text-[11px] uppercase tracking-[0.2em] text-slate-400 sm:text-xs">
          Meter updated {formatTimestamp(telemetry.timestamp)} · Solar updated{" "}
          {formatTimestamp(telemetry.hoymiles?.timestamp)}
        </p>

        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="shrink-0"
          onClick={handleSignOut}
          disabled={isSigningOut}
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">{isSigningOut ? "Signing out" : "Sign out"}</span>
        </Button>
      </div>

      <nav aria-label="Primary" className="mt-4">
        <div className="grid grid-cols-4 gap-2">
          {tabs.map((tab) => {
            const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            const Icon = tab.icon;

            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center rounded-[1.15rem] border px-3 py-2 text-xs font-medium transition-all",
                  active
                    ? "border-sky-400/35 bg-sky-400/12 text-sky-100 shadow-[0_0_0_1px_rgba(56,189,248,0.15)]"
                    : "border-white/10 bg-white/[0.03] text-slate-400 hover:bg-white/[0.08] hover:text-slate-100",
                )}
              >
                <Icon className={cn("mb-1 h-4 w-4", active && "drop-shadow-[0_0_14px_rgba(56,189,248,0.35)]")} />
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
