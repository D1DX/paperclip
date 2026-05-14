import { describe, expect, it } from "vitest";
import { describeDueDate, dueDateUrgency } from "./dueDate";

describe("dueDateUrgency", () => {
  const now = new Date("2026-06-15T10:00:00");

  it("returns null when no date is provided", () => {
    expect(dueDateUrgency(null, now)).toBeNull();
    expect(dueDateUrgency(undefined, now)).toBeNull();
    expect(dueDateUrgency("", now)).toBeNull();
  });

  it("returns 'overdue' for any past date", () => {
    expect(dueDateUrgency("2026-06-14", now)).toBe("overdue");
    expect(dueDateUrgency("2025-12-31", now)).toBe("overdue");
  });

  it("returns 'today' when the date matches now's local YYYY-MM-DD", () => {
    expect(dueDateUrgency("2026-06-15", now)).toBe("today");
  });

  it("returns 'future' for any later date", () => {
    expect(dueDateUrgency("2026-06-16", now)).toBe("future");
    expect(dueDateUrgency("2030-01-01", now)).toBe("future");
  });

  it("respects local time, not UTC — late-evening on the 15th is still 'today'", () => {
    const lateLocalEvening = new Date("2026-06-15T23:30:00");
    expect(dueDateUrgency("2026-06-15", lateLocalEvening)).toBe("today");
  });
});

describe("describeDueDate", () => {
  const now = new Date("2026-06-15T10:00:00");

  it("returns null when no date is provided", () => {
    expect(describeDueDate(null, now)).toBeNull();
  });

  it("produces past / today / future copy", () => {
    expect(describeDueDate("2026-06-14", now)).toBe("Overdue — was due 2026-06-14");
    expect(describeDueDate("2026-06-15", now)).toBe("Due today (2026-06-15)");
    expect(describeDueDate("2026-06-16", now)).toBe("Due 2026-06-16");
  });
});
