import * as React from "react";

import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "secondary" | "success" | "danger" | "warning" | "outline";

const badgeStyles: Record<BadgeVariant, string> = {
  default: "bg-sky-500/15 text-sky-200 ring-1 ring-inset ring-sky-400/30",
  secondary: "bg-white/10 text-slate-200 ring-1 ring-inset ring-white/10",
  success: "bg-emerald-500/15 text-emerald-200 ring-1 ring-inset ring-emerald-400/30",
  danger: "bg-rose-500/15 text-rose-200 ring-1 ring-inset ring-rose-400/30",
  warning: "bg-amber-500/15 text-amber-200 ring-1 ring-inset ring-amber-400/30",
  outline: "bg-transparent text-slate-200 ring-1 ring-inset ring-white/[0.15]",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: BadgeVariant;
}

function Badge({ className, variant = "secondary", ...props }: BadgeProps) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold tracking-wide",
        badgeStyles[variant],
        className,
      )}
      {...props}
    />
  );
}

export { Badge };
