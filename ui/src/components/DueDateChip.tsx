import { useRef } from "react";
import { Calendar } from "lucide-react";

interface DueDateChipProps {
  dueDate: string | null;
  onChange: (next: string | null) => void;
  className?: string;
}

export function DueDateChip({ dueDate, onChange, className }: DueDateChipProps) {
  const value = dueDate ?? "";
  const inputRef = useRef<HTMLInputElement>(null);

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
      {/* Hidden native input — covers the chip so click-anywhere also opens the picker. */}
      <input
        ref={inputRef}
        type="date"
        className="absolute inset-0 opacity-0 cursor-pointer"
        value={value}
        onChange={(e) => onChange(e.target.value ? e.target.value : null)}
        aria-label="Due date"
      />
      {value ? (
        <span
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs"
          title={`Due ${value}`}
        >
          <Calendar className="h-3 w-3 text-muted-foreground" />
          <span>{value}</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground relative z-10"
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
