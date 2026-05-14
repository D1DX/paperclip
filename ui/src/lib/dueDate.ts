import { formatLocalIsoDate } from "./issue-filters";

export type DueDateUrgency = "overdue" | "today" | "future";

/**
 * Classify a YYYY-MM-DD due date against `now` (local time).
 * Returns null when no date is provided. `now` is injectable so callers can
 * pin a stable value across a render and so tests stay deterministic.
 */
export function dueDateUrgency(
  dueDate: string | null | undefined,
  now: Date = new Date(),
): DueDateUrgency | null {
  if (!dueDate) return null;
  const today = formatLocalIsoDate(now);
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  return "future";
}

/** Tooltip / aria-label copy that matches the urgency state. */
export function describeDueDate(
  dueDate: string | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!dueDate) return null;
  const urgency = dueDateUrgency(dueDate, now);
  if (urgency === "overdue") return `Overdue — was due ${dueDate}`;
  if (urgency === "today") return `Due today (${dueDate})`;
  return `Due ${dueDate}`;
}
