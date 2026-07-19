"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChartArea, Home, Settings2, Zap } from "lucide-react";

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

export function BottomTabBar() {
  const pathname = usePathname();

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <nav
        aria-label="Primary"
        className="pointer-events-auto w-full max-w-[430px] rounded-[1.75rem] border border-white/10 bg-slate-950/80 px-2 py-2 shadow-2xl shadow-slate-950/40 backdrop-blur-2xl sm:max-w-[720px] md:max-w-[960px] lg:max-w-[1180px]"
      >
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
                  "flex flex-col items-center justify-center rounded-[1.25rem] px-3 py-2.5 text-xs font-medium transition-all",
                  active
                    ? "bg-white/[0.12] text-sky-200 shadow-inner shadow-sky-500/10"
                    : "text-slate-400 hover:bg-white/[0.08] hover:text-slate-200",
                )}
              >
                <Icon className={cn("mb-1.5 h-5 w-5", active && "drop-shadow-[0_0_14px_rgba(56,189,248,0.4)]")} />
                {tab.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
