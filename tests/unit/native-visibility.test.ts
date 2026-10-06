import { describe, expect, it } from "vitest";

import type { CalendarSnapshot } from "../../src/domain/model";

import { GoogleCalendarDomAdapter } from "../../src/gcal/adapter";
import { NativeCalendarVisibilityController } from "../../src/gcal/native-visibility";

describe("Google Calendarの表示状態操作", () => {
  it("連続したtoggleを直前の操作が反映された表示状態から計算する", async () => {
    let visible = false;
    let clicks = 0;
    const control = document.createElement("button");
    control.addEventListener("click", () => {
      clicks += 1;
      window.setTimeout(() => {
        visible = !visible;
      }, 0);
    });
    const adapter = {
      listCalendars: () => [calendar("calendar-a", visible)],
      getCalendarToggleElement: () => control,
    } as unknown as GoogleCalendarDomAdapter;
    const controller = new NativeCalendarVisibilityController(adapter);

    await Promise.all([controller.toggle("calendar-a"), controller.toggle("calendar-a")]);

    expect(clicks).toBe(2);
    expect(visible).toBe(false);
  });

  it("非同期のsidebar再描画後に現在のtoggle要素を取り直す", async () => {
    const states = new Map([
      ["calendar-a", false],
      ["calendar-b", false],
    ]);
    const controls = new Map<string, HTMLButtonElement>();
    const clickedGenerations: number[] = [];
    let generation = 0;
    let pendingGeneration = 0;

    const replaceControls = () => {
      controls.clear();
      for (const key of states.keys()) {
        const control = document.createElement("button");
        control.dataset.generation = String(generation);
        control.addEventListener("click", () => {
          clickedGenerations.push(Number(control.dataset.generation));
          window.setTimeout(() => {
            states.set(key, !states.get(key));
            pendingGeneration += 1;
          }, 0);
        });
        controls.set(key, control);
      }
    };
    replaceControls();

    const adapter = {
      listCalendars: () => {
        if (generation !== pendingGeneration) {
          generation = pendingGeneration;
          replaceControls();
        }
        return [...states].map(([key, visible]) => calendar(key, visible));
      },
      getCalendarToggleElement: (key: string) => controls.get(key) ?? null,
    } as unknown as GoogleCalendarDomAdapter;
    const controller = new NativeCalendarVisibilityController(adapter);

    const first = controller.apply([
      { calendarKey: "calendar-a", visible: true },
      { calendarKey: "calendar-b", visible: true },
    ]);
    const second = controller.apply([{ calendarKey: "calendar-a", visible: false }]);
    const idle = controller.whenIdle();

    expect(controller.applyingTransaction).toBe(true);
    await Promise.all([first, second, idle]);

    expect(clickedGenerations).toEqual([0, 1, 2]);
    expect([...states.values()]).toEqual([false, true]);
    expect(controller.applyingTransaction).toBe(false);
  });

  it("ネイティブ操作後の状態を先回りして変更しない", async () => {
    const snapshot = calendar("calendar-a", false);
    const control = document.createElement("button");
    const adapter = {
      listCalendars: () => [snapshot],
      getCalendarToggleElement: () => control,
    } as unknown as GoogleCalendarDomAdapter;
    const controller = new NativeCalendarVisibilityController(adapter);

    await controller.apply([{ calendarKey: "calendar-a", visible: true }]);

    expect(snapshot.visible).toBe(false);
  });
});

function calendar(key: string, visible: boolean): CalendarSnapshot {
  return {
    key,
    label: key,
    confidence: "strong",
    ownership: "unknown",
    visible,
  };
}
