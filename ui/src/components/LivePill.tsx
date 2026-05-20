import { cn } from "../lib/utils";

/**
 * Blue pulsing "Live" pill (D-1155). Presence-driven liveness badge — shown on
 * an agent when an operator-paced session is actively working. Distinct from
 * LiveRunIndicator, which is heartbeat-run based and never fires for
 * operator-paced agents (they have no runs). Visual style matches both the
 * issue "Live" pill and LiveRunIndicator so the three read as one signal.
 */
export function LivePill({ label = "Live", className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full bg-blue-500/10 px-2 py-0.5",
        className,
      )}
      title="A session is actively working"
    >
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      <span className="text-[11px] font-medium text-blue-600 dark:text-blue-400">{label}</span>
    </span>
  );
}
