import { describe, expect, it } from "vitest";

import type { CalendarEvent, CalendarSnapshot } from "../../src/domain/model";

import { createCalendarViewAdapters } from "../../src/gcal/view-adapter";
import { EventRenderer, readableForegroundColor } from "../../src/presentation/renderer";
import { createDefaultSettings } from "../../src/storage/settings";

describe("予定の文字色コントラスト", () => {
  it("十分なコントラストがある文字色は維持する", () => {
    expect(readableForegroundColor("rgb(32, 33, 36)", "#ffffff", 1, "#ffffff")).toBeNull();
  });

  it("暗い予定色では明るい文字色を選ぶ", () => {
    expect(readableForegroundColor("rgb(32, 33, 36)", "#303134", 1, "#ffffff")).toBe("#f8f9fa");
  });

  it("明るい予定色では暗い文字色を選ぶ", () => {
    expect(readableForegroundColor("rgb(248, 249, 250)", "#f8f9fa", 1, "#ffffff")).toBe("#202124");
  });

  it("透明度と背景色を合成して文字色を選ぶ", () => {
    expect(readableForegroundColor("rgb(248, 249, 250)", "#ffffff", 0.5, "#202124")).toBe(
      "#202124",
    );
  });

  it("Spotlight opacityをevent内で合成した文字色と背景色へ同じように適用する", () => {
    expect(readableForegroundColor("rgba(0, 0, 0, 0.5)", "#ffffff", 1, "#000000", 0.5)).toBe(
      "#202124",
    );
  });

  it("未対応の背景色では指定されたcanvas色に合う文字色を選ぶ", () => {
    expect(readableForegroundColor("rgb(248, 249, 250)", "var(--custom-color)", 1, "#ffffff")).toBe(
      "#202124",
    );
  });

  it("設定を解除するとrendererが予定の元の文字色を復元する", () => {
    const element = document.createElement("div");
    element.style.setProperty("color", "rgb(248, 249, 250)", "important");
    element.style.setProperty("background-color", "rgb(66, 133, 244)");
    const originalColor = element.style.getPropertyValue("color");
    const originalColorPriority = element.style.getPropertyPriority("color");
    const event: CalendarEvent = {
      ref: "event-a",
      calendarKey: "calendar-a",
      calendarConfidence: "strong",
      eventConfidence: "strong",
      ownership: "mine",
      title: "Planning",
      dateKey: "2026-10-07",
      start: "2026-10-07T09:00:00.000Z",
      end: "2026-10-07T09:30:00.000Z",
      allDay: false,
      view: "week",
      domOrder: 0,
    };
    const calendar: CalendarSnapshot = {
      key: "calendar-a",
      label: "Primary",
      confidence: "strong",
      ownership: "mine",
      visible: true,
      nativeColor: "#4285f4",
    };
    const settings = createDefaultSettings();
    settings.mergeEnabled = false;
    settings.calendars[calendar.key] = { color: "#303134", opacity: 1 };
    const renderer = new EventRenderer(createCalendarViewAdapters());
    const events = new Map([[element, event]]);

    renderer.render(events, [calendar], settings, new Set());
    expect(element.style.getPropertyValue("color")).toBe("#f8f9fa");

    delete settings.calendars[calendar.key];
    renderer.render(events, [calendar], settings, new Set());
    expect(element.style.getPropertyValue("color")).toBe(originalColor);
    expect(element.style.getPropertyPriority("color")).toBe(originalColorPriority);
    renderer.restoreAll();
  });
});
