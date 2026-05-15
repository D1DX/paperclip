import { useRef } from "react";
import { Calendar } from "lucide-react";
import { describeDueDate, dueDateUrgency } from "../lib/dueDate";
import { cn } from "../lib/utils";

interface DueDateChipProps {
  dueDate: string | null;
  onChange: (next: string | null) => void;
  className?: string;
}

export function DueDateChip({ dueDate, onChange, className }: DueDateChipProps) {
  const value = dueDate ?? "";
  const inputRef = useRef<HTMLInputElement>(null);
  const urgency = dueDateUrgency(dueDate);
  const isUrgent = urgency === "overdue" || urgency === "today";

  const openPicker = () => {
    const input = inputRef.current;
    if (!input) return;
    // showPicker() is the modern path; some browsers/embedded webviews lack it,
    // so fall back to focus() which surfaces the native control on most platforms.
    if (typeof input.showPicker === "function") {
      try {
        input.showPicker();
        return;
      } catch {
        // Fall through to focus().
      }
    }
    input.focus();
  };

  return (
    <div
      className={
        "relative inline-flex items-center shrink-0 " + (className ?? "")
      }
    >
      {/* Hidden native input — receives onChange when the picker selects a date.
          pointer-events-none so the visible chip below is the click target;
          the picker is opened programmatically via showPicker() from openPicker(). */}
      <input
        ref={inputRef}
        type="date"
        className="absolute inset-0 opacity-0 pointer-events-none"
        value={value}
        onChange={(e) => onChange(e.target.value ? e.target.value : null)}
        aria-hidden="true"
        tabIndex={-1}
      />
      {value ? (
        <span
          role="button"
          tabIndex={0}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs cursor-pointer",
            isUrgent
              ? "border-red-500/60 bg-red-500/10 text-red-700 dark:bg-red-500/15 dark:text-red-300"
              : "border-border bg-muted/50 text-foreground/90 dark:bg-white/5 dark:text-foreground",
          )}
          title={describeDueDate(value) ?? `Due ${value}`}
          aria-label={`Due ${value} — click to change`}
          onClick={openPicker}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openPicker();
            }
          }}
        >
          <Calendar className={cn("h-3 w-3", isUrgent ? "" : "text-muted-foreground")} />
          <span>{value}</span>
          <button
            type="button"
            className={cn(
              "relative z-10",
              isUrgent
                ? "text-red-700/80 hover:text-red-700 dark:text-red-300/80 dark:hover:text-red-200"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
            aria-label="Clear due date"
          >
            ×
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground hover:border-border"
          onClick={openPicker}
          aria-label="Set due date"
          title="Set due date"
        >
          <Calendar className="h-3 w-3" />
          <span>Set date</span>
        </button>
      )}
    </div>
  );
}
