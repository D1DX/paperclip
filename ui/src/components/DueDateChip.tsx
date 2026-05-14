import { Calendar } from "lucide-react";

interface DueDateChipProps {
  dueDate: string | null;
  onChange: (next: string | null) => void;
  className?: string;
}

export function DueDateChip({ dueDate, onChange, className }: DueDateChipProps) {
  const value = dueDate ?? "";
  return (
    <div
      className={
        "inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-xs shrink-0 " +
        (className ?? "")
      }
    >
      <Calendar className="h-3 w-3 text-muted-foreground" />
      <input
        type="date"
        className="bg-transparent outline-none text-xs w-28"
        value={value}
        onChange={(e) => onChange(e.target.value ? e.target.value : null)}
        placeholder="Due date"
        aria-label="Due date"
      />
      {value && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground"
          onClick={() => onChange(null)}
          aria-label="Clear due date"
        >
          ×
        </button>
      )}
    </div>
  );
}
