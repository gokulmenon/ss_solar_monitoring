import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type MetricCardProps = {
  label: string;
  value: string;
  detail?: string;
  tone?: "neutral" | "green" | "red" | "amber" | "blue";
};

const toneStyles: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  neutral: "from-white/5 to-white/[0.02]",
  green: "from-emerald-500/15 to-white/[0.02]",
  red: "from-rose-500/15 to-white/[0.02]",
  amber: "from-amber-500/15 to-white/[0.02]",
  blue: "from-sky-500/15 to-white/[0.02]",
};

export function MetricCard({
  label,
  value,
  detail,
  tone = "neutral",
}: MetricCardProps) {
  return (
    <Card className={cn("bg-gradient-to-br", toneStyles[tone])}>
      <CardHeader className="pb-2">
        <CardDescription className="text-[11px] uppercase tracking-[0.22em] text-slate-400">
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <CardTitle className="text-2xl font-semibold tracking-tight">{value}</CardTitle>
        {detail ? <p className="mt-2 text-sm text-slate-400">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}
