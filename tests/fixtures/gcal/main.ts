import type { ApplicationHandle } from "../../../src/application";
import type { LocalStorageArea } from "../../../src/storage/settings";

import { mountCalendarMergerApplication } from "../../../src/application";

declare global {
  interface Window {
    calendarMergerApp?: ApplicationHandle;
  }
}

const colors = [
  "#4285f4",
  "#34a853",
  "#fbbc04",
  "#ea4335",
  "#a142f4",
  "#24c1e0",
  "#ff6d01",
  "#5f6368",
  "#d01884",
  "#00897b",
];
const calendars = Array.from({ length: 10 }, (_, index) => ({
  id: `calendar-${index + 1}`,
  name: `Calendar ${String.fromCharCode(65 + index)}`,
  color: colors[index] ?? "#4285f4",
}));

const sidebar = document.querySelector<HTMLElement>("#calendar-sidebar");
const grid = document.querySelector<HTMLElement>("#calendar-grid");
const viewControls = document.querySelector<HTMLElement>("#view-controls");
const extensionHost = document.querySelector<HTMLElement>("#extension-host");
if (!sidebar || !grid || !viewControls || !extensionHost)
  throw new Error("Fixture containers are missing.");

function createCalendarRow(calendar: (typeof calendars)[number], visible = true): HTMLElement {
  const row = document.createElement("div");
  row.setAttribute("role", "listitem");
  row.setAttribute("data-fixture-calendar-row", "");
  row.setAttribute("data-calendar-id", calendar.id);
  row.setAttribute(
    "data-calendar-owner",
    calendar.id === "calendar-1" ? "mine" : calendar.id === "calendar-2" ? "other" : "unknown",
  );
  const color = document.createElement("span");
  color.setAttribute("data-calendar-color", calendar.color);
  color.setAttribute("data-fixture-color", "");
  color.style.backgroundColor = calendar.color;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.setAttribute("role", "checkbox");
  toggle.setAttribute("aria-label", calendar.name);
  toggle.setAttribute("aria-checked", String(visible));
  toggle.setAttribute("data-fixture-calendar-toggle", calendar.id);
  toggle.textContent = calendar.name;
  row.append(color, toggle);
  return row;
}

for (const calendar of calendars) sidebar.append(createCalendarRow(calendar));

function renderNativeSidebar(): void {
  const current = document.querySelector<HTMLElement>("#calendar-sidebar");
  if (!current) return;

  const visibility = new Map(
    [...current.querySelectorAll<HTMLElement>("[data-fixture-calendar-toggle]")].map((toggle) => [
      toggle.dataset.fixtureCalendarToggle ?? "",
      toggle.getAttribute("aria-checked") === "true",
    ]),
  );
  const replacement = current.cloneNode(false) as HTMLElement;
  for (const calendar of calendars)
    replacement.append(createCalendarRow(calendar, visibility.get(calendar.id) ?? true));
  current.replaceWith(replacement);
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches("[data-fixture-calendar-toggle]")) return;
  target.setAttribute("aria-checked", String(target.getAttribute("aria-checked") !== "true"));
});

document.querySelector("[data-fixture-rerender-sidebar]")?.addEventListener("click", () => {
  renderNativeSidebar();
});

document.querySelector("[data-fixture-add-calendar]")?.addEventListener("click", () => {
  const current = document.querySelector<HTMLElement>("#calendar-sidebar");
  if (!current || calendars.some(({ id }) => id === "calendar-11")) return;
  calendars.push({ id: "calendar-11", name: "Calendar K", color: "#607d8b" });
  renderNativeSidebar();
});

for (const [selector, amount] of [
  ["[data-fixture-next-period]", 7],
  ["[data-fixture-previous-period]", -7],
] as const) {
  document.querySelector(selector)?.addEventListener("click", () => {
    const activeView = document.querySelector<HTMLElement>("[data-fixture-view]:not([hidden])");
    for (const event of activeView?.querySelectorAll<HTMLElement>("[data-eventid]") ?? []) {
      for (const name of ["data-start", "data-end"]) {
        const value = event.getAttribute(name);
        if (!value) continue;
        const date = new Date(value);
        date.setUTCDate(date.getUTCDate() + amount);
        event.setAttribute(name, date.toISOString());
      }
    }
  });
}

document.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
});

const eventViews = ["day", "week", "month", "schedule", "year"] as const;
const views = new Map<string, HTMLElement>();
for (const view of eventViews) {
  const section = document.createElement("section");
  section.setAttribute("data-fixture-view", view);
  if (view === "week") section.style.position = "relative";
  section.hidden = view !== "week";
  const heading = document.createElement("h1");
  heading.textContent = `${view} view fixture`;
  section.append(heading);
  grid.append(section);
  views.set(view, section);
  const control = document.createElement("button");
  control.type = "button";
  control.textContent = view;
  control.setAttribute("data-view-button", view);
  control.setAttribute("aria-pressed", String(view === "week"));
  control.addEventListener("click", () => {
    document.documentElement.setAttribute("data-calendar-view", view);
    for (const [key, element] of views) element.hidden = key !== view;
    for (const button of viewControls.querySelectorAll<HTMLButtonElement>("[data-view-button]")) {
      button.setAttribute("aria-pressed", String(button === control));
    }
  });
  viewControls.append(control);
}

function addEvent(
  view: (typeof eventViews)[number],
  calendarIndex: number,
  title: string,
  start: string,
  end: string,
  options: { allDay?: boolean; idSuffix?: string } = {},
): HTMLButtonElement {
  const calendar = calendars[calendarIndex];
  const parent = views.get(view);
  if (!calendar || !parent) throw new Error(`Fixture data is invalid for ${view}.`);
  const event = document.createElement("button");
  event.type = "button";
  event.setAttribute(
    "data-eventid",
    `${calendar.id}-${options.idSuffix ?? title.replaceAll(" ", "-")}`,
  );
  event.setAttribute("data-calendar-id", calendar.id);
  event.setAttribute("data-event-title", title);
  event.setAttribute("data-start", start);
  event.setAttribute("data-end", end);
  if (options.allDay) event.setAttribute("data-all-day", "true");
  event.style.backgroundColor = calendar.color;
  if (
    view === "week" &&
    (title === "Weekly Design" || title === "Town Hall" || title === "Unsafe layout")
  ) {
    event.style.position = "absolute";
    event.style.left = `${calendarIndex * 100}px`;
    event.style.top = title === "Weekly Design" ? "80px" : "140px";
    event.style.width = "96px";
    event.style.height = "32px";
    event.style.minWidth = "0";
    event.style.boxSizing = "border-box";
    event.style.margin = "0";
    if (title === "Unsafe layout") event.style.transform = "translateX(1px)";
  }
  event.textContent = title;
  parent.append(event);
  return event;
}

const dayStart = "2026-10-05T09:00:00.000Z";
const dayEnd = "2026-10-05T09:30:00.000Z";
for (const index of [0, 1]) addEvent("day", index, "Daily standup", dayStart, dayEnd);

const weekStart = "2026-10-06T10:00:00.000Z";
const weekEnd = "2026-10-06T11:00:00.000Z";
for (let index = 0; index < 3; index += 1)
  addEvent("week", index, "Weekly Design", weekStart, weekEnd);
for (let index = 0; index < 10; index += 1)
  addEvent("week", index, "Town Hall", "2026-10-07T13:00:00.000Z", "2026-10-07T14:00:00.000Z");
for (const index of [0, 1])
  addEvent("week", index, "Busy", "2026-10-08T15:00:00.000Z", "2026-10-08T16:00:00.000Z");
addEvent("week", 3, "Focus block", "2026-10-08T17:00:00.000Z", "2026-10-08T17:30:00.000Z");
for (const index of [4, 5])
  addEvent("week", index, "Unsafe layout", "2026-10-08T18:00:00.000Z", "2026-10-08T19:00:00.000Z");

for (const index of [0, 1])
  addEvent("month", index, "Product launch", "2026-10-12", "2026-10-13", { allDay: true });

const scheduleStart = "2026-10-20T09:00:00.000Z";
for (const index of [0, 1])
  addEvent("schedule", index, "Same title", scheduleStart, "2026-10-20T09:30:00.000Z");
addEvent("schedule", 0, "Repeated", "2026-10-21T11:00:00.000Z", "2026-10-21T11:30:00.000Z", {
  idSuffix: "repeat-a",
});
addEvent("schedule", 0, "Repeated", "2026-10-21T11:00:00.000Z", "2026-10-21T11:30:00.000Z", {
  idSuffix: "repeat-b",
});
addEvent("schedule", 1, "Repeated", "2026-10-21T11:00:00.000Z", "2026-10-21T11:30:00.000Z");
addEvent("schedule", 2, "Same title", "2026-10-20T10:00:00.000Z", "2026-10-20T10:30:00.000Z");
addEvent("schedule", 2, "Another title", scheduleStart, "2026-10-20T09:30:00.000Z");

for (const index of [0, 1])
  addEvent("year", index, "Holiday", "2026-12-24", "2026-12-27", { allDay: true });

const storage: LocalStorageArea = {
  async get(key) {
    if (key === null || key === undefined) {
      const values: Record<string, unknown> = {};
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const storageKey = window.localStorage.key(index);
        if (!storageKey) continue;
        const raw = window.localStorage.getItem(storageKey);
        if (raw) values[storageKey] = JSON.parse(raw) as unknown;
      }
      return values;
    }
    const raw = window.localStorage.getItem(key);
    return raw ? { [key]: JSON.parse(raw) as unknown } : {};
  },
  async set(items) {
    for (const [key, value] of Object.entries(items))
      window.localStorage.setItem(key, JSON.stringify(value));
  },
};

const shadow = extensionHost.attachShadow({ mode: "open" });
const uiContainer = document.createElement("div");
shadow.append(uiContainer);
void mountCalendarMergerApplication(document, uiContainer, storage).then((application) => {
  window.calendarMergerApp = application;
});
