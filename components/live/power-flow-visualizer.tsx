import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type PowerFlowVisualizerProps = {
  solarProductionW: number;
  netGridW: number;
  homeConsumptionW: number;
};

function FlowPulse({
  pathId,
  tint,
  delay = "0s",
}: {
  pathId: string;
  tint: string;
  delay?: string;
}) {
  return (
    <circle r="4.5" fill={tint} opacity="0.95">
      <animateMotion dur="1.6s" repeatCount="indefinite" begin={delay}>
        <mpath xlinkHref={`#${pathId}`} />
      </animateMotion>
    </circle>
  );
}

export function PowerFlowVisualizer({
  solarProductionW,
  netGridW,
  homeConsumptionW,
}: PowerFlowVisualizerProps) {
  const exporting = netGridW < 0;
  const importing = netGridW > 0;
  const surplusW = Math.max(0, solarProductionW - homeConsumptionW);
  const gridFlowW = Math.abs(netGridW);
  const hasSolarGeneration = solarProductionW > 10;

  return (
    <Card className="overflow-hidden border-white/10 bg-slate-950/80">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm uppercase tracking-[0.22em] text-slate-400">
          Power Flow
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="rounded-[1.5rem] border border-white/[0.08] bg-gradient-to-b from-slate-900/80 to-slate-950 p-4">
          <svg
            viewBox="0 0 360 250"
            className="h-auto w-full"
            role="img"
            aria-label="Solar, grid, and house power flow diagram"
          >
            <defs>
              <linearGradient id="solarGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#f59e0b" stopOpacity="0.92" />
              </linearGradient>
              <linearGradient id="gridGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.92" />
              </linearGradient>
              <linearGradient id="homeGlow" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#34d399" stopOpacity="0.18" />
                <stop offset="100%" stopColor="#34d399" stopOpacity="0.92" />
              </linearGradient>
              <filter id="softGlow">
                <feGaussianBlur stdDeviation="5" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            <g opacity="0.7">
              <path d="M84 68 C126 96, 146 112, 180 152" stroke="rgba(251,191,36,0.20)" strokeWidth="10" fill="none" />
              <path d="M276 68 C244 98, 224 115, 194 152" stroke="rgba(56,189,248,0.18)" strokeWidth="10" fill="none" />
            </g>

            <path
              id="solarToHouse"
              d="M84 68 C126 96, 146 112, 180 152"
              stroke="url(#solarGlow)"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity={hasSolarGeneration ? 1 : 0}
            />
            <path
              id="gridToHouse"
              d="M276 68 C244 98, 224 115, 194 152"
              stroke="url(#gridGlow)"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity={importing ? 1 : 0.22}
            />
            <path
              id="houseToGrid"
              d="M180 152 C210 120, 235 96, 276 68"
              stroke="url(#gridGlow)"
              strokeWidth="4"
              fill="none"
              strokeLinecap="round"
              opacity={exporting ? 1 : 0.18}
            />

            {hasSolarGeneration ? (
              <>
                <FlowPulse pathId="solarToHouse" tint="#fde047" />
                {surplusW > 0 ? <FlowPulse pathId="houseToGrid" tint="#34d399" delay="0.75s" /> : null}
              </>
            ) : null}
            {importing ? <FlowPulse pathId="gridToHouse" tint="#38bdf8" delay="0.35s" /> : null}
            {exporting ? <FlowPulse pathId="houseToGrid" tint="#34d399" delay="0.35s" /> : null}

            <g filter="url(#softGlow)">
              <rect x="34" y="20" width="100" height="80" rx="22" fill="rgba(15,118,110,0.22)" stroke="rgba(251,191,36,0.7)" />
              <rect x="58" y="38" width="52" height="32" rx="8" fill="rgba(251,191,36,0.16)" stroke="rgba(251,191,36,0.9)" />
              <path d="M64 46 H104 M64 54 H104 M72 38 V70 M86 38 V70 M98 38 V70" stroke="rgba(254,240,138,0.75)" strokeWidth="1.4" />
              <text x="84" y="90" textAnchor="middle" className="fill-slate-100 text-[11px] font-semibold tracking-[0.25em]">
                SOLAR
              </text>
              <text x="84" y="104" textAnchor="middle" className="fill-slate-400 text-[9px]">
                {solarProductionW > 10 ? `${(solarProductionW / 1000).toFixed(1)} kW` : "0 W"}
              </text>

              <rect x="252" y="20" width="88" height="80" rx="22" fill="rgba(14,165,233,0.18)" stroke="rgba(56,189,248,0.82)" />
              <path d="M274 34 L260 68 H275 L267 98 L294 58 H281 L288 34 Z" fill="rgba(56,189,248,0.18)" stroke="rgba(56,189,248,0.95)" />
              <text x="296" y="90" textAnchor="middle" className="fill-slate-100 text-[11px] font-semibold tracking-[0.25em]">
                GRID
              </text>
              <text x="296" y="104" textAnchor="middle" className="fill-slate-400 text-[9px]">
                {gridFlowW === 0 ? "0 W" : `${(gridFlowW / 1000).toFixed(1)} kW`}
              </text>

              <path
                d="M154 190 L180 152 L206 190 V214 H154 Z"
                fill="rgba(16,185,129,0.18)"
                stroke="rgba(52,211,153,0.95)"
                strokeLinejoin="round"
              />
              <path
                d="M162 190 H198"
                stroke="rgba(52,211,153,0.95)"
                strokeLinecap="round"
                strokeWidth="3"
              />
              <text x="180" y="232" textAnchor="middle" className="fill-slate-100 text-[11px] font-semibold tracking-[0.25em]">
                HOUSE
              </text>
              <text x="180" y="246" textAnchor="middle" className="fill-slate-400 text-[9px]">
                {(homeConsumptionW / 1000).toFixed(1)} kW
              </text>
            </g>
          </svg>

          <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-slate-400">
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-center">
              <div className="text-slate-200">Solar</div>
              <div>{Math.round(solarProductionW).toLocaleString()} W</div>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-center">
              <div className="text-slate-200">Grid</div>
              <div className={cn(exporting ? "text-emerald-300" : importing ? "text-rose-300" : "text-slate-300")}>
                {netGridW > 0 ? "+" : ""}
                {Math.round(netGridW).toLocaleString()} W
              </div>
            </div>
            <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-center">
              <div className="text-slate-200">Home</div>
              <div>{Math.round(homeConsumptionW).toLocaleString()} W</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
