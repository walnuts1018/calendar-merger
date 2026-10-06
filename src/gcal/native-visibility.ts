import type { CalendarSnapshot } from "../domain/model";
import type { VisibilityChange } from "../domain/visibility";

import { GoogleCalendarDomAdapter } from "./adapter";

const maxVisibilityAttempts = 2;
const maxVisibilityFrames = 24;
const maxVisibilityWaitMs = 400;

export class NativeCalendarVisibilityController {
  private pending = Promise.resolve();
  private transactionDepth = 0;

  constructor(private readonly adapter: GoogleCalendarDomAdapter) {}

  get applyingTransaction(): boolean {
    return this.transactionDepth > 0;
  }

  whenIdle(): Promise<void> {
    return this.pending;
  }

  toggle(calendarKey: string): Promise<void> {
    return this.applyFrom((calendars) => {
      const calendar = calendars.find((entry) => entry.key === calendarKey);
      return calendar ? [{ calendarKey, visible: !calendar.visible }] : [];
    });
  }

  apply(changes: readonly VisibilityChange[]): Promise<void> {
    if (changes.length === 0) return Promise.resolve();
    return this.enqueue(async () => {
      for (const change of changes) await this.applyChange(change);
    });
  }

  applyFrom(
    plan: (calendars: readonly CalendarSnapshot[]) => readonly VisibilityChange[],
  ): Promise<void> {
    return this.enqueue(async () => {
      const calendars = this.adapter
        .listCalendars()
        .filter((calendar) => calendar.confidence !== "weak");
      for (const change of plan(calendars)) await this.applyChange(change);
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    this.transactionDepth += 1;
    const result = this.pending.then(operation);
    this.pending = result.then(
      () => {
        this.transactionDepth -= 1;
      },
      () => {
        this.transactionDepth -= 1;
      },
    );
    return result;
  }

  private async applyChange(change: VisibilityChange): Promise<void> {
    for (let attempt = 0; attempt < maxVisibilityAttempts; attempt += 1) {
      const calendar = this.adapter
        .listCalendars()
        .find((entry) => entry.key === change.calendarKey);
      if (!calendar || calendar.confidence === "weak" || calendar.visible === change.visible)
        return;

      const control = this.adapter.getCalendarToggleElement(change.calendarKey);
      if (!control || control.getAttribute("aria-disabled") === "true") return;
      if (control.tagName === "INPUT" && (control as HTMLInputElement).disabled) return;

      if (await this.clickAndWaitForVisibility(change.calendarKey, change.visible, control)) return;
      const currentControl = this.adapter.getCalendarToggleElement(change.calendarKey);
      if (!currentControl?.isConnected || currentControl === control) return;
    }
  }

  private clickAndWaitForVisibility(
    calendarKey: string,
    visible: boolean,
    control: HTMLElement,
  ): Promise<boolean> {
    const document = control.ownerDocument;
    const window = document.defaultView;
    if (!window) return Promise.resolve(false);

    return new Promise((resolve) => {
      const Observer = window.MutationObserver;
      let observer: MutationObserver | undefined;
      let frameHandle: number | undefined;
      let pollHandle: number | undefined;
      let timeoutHandle: number | undefined;
      let frames = 0;
      let mutationVersion = 0;
      let checkedMutationVersion = -1;
      let stableFrames = 0;
      let finished = false;

      const isVisible = () =>
        this.adapter.listCalendars().find((calendar) => calendar.key === calendarKey)?.visible ===
        visible;

      const finish = (settled: boolean) => {
        if (finished) return;
        finished = true;
        observer?.disconnect();
        if (frameHandle !== undefined) window.cancelAnimationFrame(frameHandle);
        if (pollHandle !== undefined) window.clearTimeout(pollHandle);
        if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
        resolve(settled);
      };

      const check = () => {
        frameHandle = undefined;
        frames += 1;
        const currentlyVisible = isVisible();
        if (currentlyVisible && mutationVersion === checkedMutationVersion) stableFrames += 1;
        else stableFrames = 0;
        checkedMutationVersion = mutationVersion;

        if ((frames >= 2 && stableFrames >= 2) || frames >= maxVisibilityFrames) {
          finish(currentlyVisible);
          return;
        }
        frameHandle = window.requestAnimationFrame(check);
      };

      if (Observer && document.body) {
        observer = new Observer(() => {
          mutationVersion += 1;
        });
        observer.observe(document.body, {
          attributes: true,
          attributeFilter: ["aria-checked", "aria-label", "checked", "data-id", "role"],
          childList: true,
          subtree: true,
        });
      }
      control.click();
      timeoutHandle = window.setTimeout(() => finish(isVisible()), maxVisibilityWaitMs);
      pollHandle = window.setTimeout(check, 0);
    });
  }
}
