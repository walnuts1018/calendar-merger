import type { VisibilityChange } from "../domain/visibility";

import { GoogleCalendarDomAdapter } from "./adapter";

export class NativeCalendarVisibilityController {
  private transactionDepth = 0;

  constructor(private readonly adapter: GoogleCalendarDomAdapter) {}

  get applyingTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  toggle(calendarKey: string): void {
    const calendar = this.adapter.getCalendars().find((entry) => entry.key === calendarKey);
    if (calendar) this.apply([{ calendarKey, visible: !calendar.visible }]);
  }

  apply(changes: readonly VisibilityChange[]): void {
    if (this.transactionDepth > 0 || changes.length === 0) return;
    this.transactionDepth += 1;
    const calendars = new Map(
      this.adapter.getCalendars().map((calendar) => [calendar.key, calendar]),
    );

    try {
      for (const change of changes) {
        const calendar = calendars.get(change.calendarKey);
        if (!calendar || calendar.confidence === "weak" || calendar.visible === change.visible)
          continue;
        const control = this.adapter.getCalendarToggleElement(change.calendarKey);
        if (!control || control.getAttribute("aria-disabled") === "true") continue;
        if (control.tagName === "INPUT" && (control as HTMLInputElement).disabled) continue;
        control.click();
        calendar.visible = change.visible;
      }
    } finally {
      queueMicrotask(() => {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
      });
    }
  }
}
