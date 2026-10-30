import { cn } from "cn";

import type { PublicNeed } from "./labels";
import { demandLabels } from "./labels";

type Band = PublicNeed["demandBand"];

const filled: Record<Band, number> = { high: 3, low: 1, medium: 2 };
const fill: Record<Band, string> = {
  high: "bg-demand-high",
  low: "bg-demand-low",
  medium: "bg-demand-medium",
};

/** Demand as words plus a three-step rule meter; the words carry the meaning, not the colour. */
export function DemandBand({ band, className }: { band: Band; className?: string }) {
  return (
    <span
      className={cn(
        "text-muted-foreground inline-flex items-center gap-2 text-[13px] whitespace-nowrap",
        className,
      )}
      data-band={band}
      data-slot="demand-band"
    >
      <span aria-hidden="true" className="inline-flex gap-0.5">
        {[1, 2, 3].map((step) => (
          <span
            className={cn("h-0.5 w-2.5", step <= filled[band] ? fill[band] : "bg-border")}
            key={step}
          />
        ))}
      </span>
      {demandLabels[band]}
    </span>
  );
}
