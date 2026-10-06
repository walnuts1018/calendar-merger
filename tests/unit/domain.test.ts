import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import type { CalendarEvent, MergeGroup } from "../../src/domain/model";

import { composeEventPresentation, normalizeOpacity } from "../../src/domain/appearance";
import {
  chooseCanonicalEvent,
  createMergeKey,
  groupMergeCandidates,
  normalizeTitle,
} from "../../src/domain/merge";
import {
  groupVisibilityTarget,
  profileVisibilityChanges,
  SoloVisibilityTransaction,
  visibilityChanges,
} from "../../src/domain/visibility";
import { GoogleCalendarDomAdapter } from "../../src/gcal/adapter";
import {
  calendarConfidence,
  calendarFallbackKey,
  decodeCalendarIdFromEventId,
  readCalendarId,
  resolveCalendarByLabel,
} from "../../src/gcal/identity";
import { createCalendarViewAdapters } from "../../src/gcal/view-adapter";
import { createDefaultSettings, migrateSettings } from "../../src/storage/settings";

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    ref: "event-a",
    calendarKey: "calendar-a",
    calendarConfidence: "strong",
    eventConfidence: "strong",
    ownership: "unknown",
    title: "Planning",
    dateKey: "2026-10-06",
    start: "2026-10-06T09:00:00.000Z",
    end: "2026-10-06T09:30:00.000Z",
    allDay: false,
    view: "week",
    domOrder: 0,
    ...overrides,
  };
}

describe("Merge candidate safety", () => {
  it("タイトルのUnicode表現と空白だけを正規化する", () => {
    expect(normalizeTitle("  Ｐｌａｎｎｉｎｇ　 review  ")).toBe("Planning review");
    expect(normalizeTitle("Planning-review")).not.toBe(normalizeTitle("Planning review"));
    expect(normalizeTitle("Team A")).not.toBe(normalizeTitle("team a"));
  });

  it("異なるカレンダーの同一予定だけをまとめる", () => {
    const original = event();
    const duplicate = event({ ref: "event-b", calendarKey: "calendar-b", domOrder: 1 });
    expect(groupMergeCandidates([original, duplicate])).toMatchObject([
      { members: [original, duplicate], calendarKeys: ["calendar-a", "calendar-b"] },
    ]);

    expect(
      groupMergeCandidates([
        original,
        duplicate,
        event({ ref: "event-c", calendarKey: "calendar-c", title: "Different title" }),
        event({ ref: "event-d", calendarKey: "calendar-d", end: "2026-10-06T10:00:00.000Z" }),
        event({ ref: "event-e", calendarKey: "calendar-e", view: "month" }),
      ]),
    ).toHaveLength(1);
  });

  it("同一カレンダーに同一候補が複数ある場合は全体を除外しprivate placeholderとweak identityも除外する", () => {
    const first = event();
    const sameCalendarDuplicate = event({ ref: "same-calendar", domOrder: 1 });
    const otherCalendarDuplicate = event({ ref: "other-calendar", calendarKey: "calendar-b" });
    const thirdCalendarDuplicate = event({
      ref: "third-calendar",
      calendarKey: "calendar-c",
      domOrder: 3,
    });
    const privateEvents = [
      event({ ref: "busy-a", title: "Busy" }),
      event({ ref: "busy-b", calendarKey: "calendar-b", title: "Busy" }),
      event({ ref: "private-a", title: "Private" }),
      event({ ref: "private-b", calendarKey: "calendar-b", title: "Private" }),
      event({ ref: "予定-a", title: "予定あり" }),
      event({ ref: "予定-b", calendarKey: "calendar-b", title: "予定あり" }),
    ];

    expect(
      groupMergeCandidates([
        first,
        sameCalendarDuplicate,
        otherCalendarDuplicate,
        thirdCalendarDuplicate,
      ]),
    ).toHaveLength(0);
    expect(groupMergeCandidates(privateEvents)).toHaveLength(0);
    expect(createMergeKey(event({ calendarConfidence: "weak" }))).toBeNull();
    expect(createMergeKey(event({ eventConfidence: "weak" }))).toBeNull();
    expect(createMergeKey(event({ title: "Busy, October 6, 9:00 AM" }))).toBeNull();
  });

  it("週表示の同じ日付と同じ描画時刻を持つ予定だけをまとめる", () => {
    const first = event({ start: "", end: "", layoutKey: "28999:1055:46" });
    const duplicate = event({
      ref: "layout-b",
      calendarKey: "calendar-b",
      start: "",
      end: "",
      layoutKey: "28999:1055:46",
    });
    const differentSlot = event({
      ref: "layout-c",
      calendarKey: "calendar-c",
      start: "",
      end: "",
      layoutKey: "28999:1060:46",
    });

    expect(groupMergeCandidates([first, duplicate, differentSlot])).toMatchObject([
      { members: [first, duplicate] },
    ]);
    expect(createMergeKey(event({ start: "", end: "" }))).toBeNull();
  });

  it("10件でもlinear groupingを使いmineの予定をcanonicalに選ぶ", () => {
    const duplicates = Array.from({ length: 10 }, (_, index) =>
      event({
        ref: `event-${index}`,
        calendarKey: `calendar-${index}`,
        ownership: index === 8 ? "mine" : "other",
        domOrder: index,
      }),
    );
    const group = groupMergeCandidates(duplicates)[0];
    expect(group?.members).toHaveLength(10);
    expect(group?.canonical.ref).toBe("event-8");
    expect(chooseCanonicalEvent(duplicates)?.ref).toBe("event-8");
  });
});

describe("Calendar identity", () => {
  it("hrefのsrcをIDとして使い、曖昧な同名calendarを解決しない", () => {
    const row = document.createElement("div");
    row.setAttribute("role", "listitem");
    const link = document.createElement("a");
    link.href = "/calendar/u/0/r?src=team%40example.test";
    row.append(link);

    expect(readCalendarId(row)).toBe("team@example.test");
    expect(calendarConfidence(row, "Team", true)).toBe("strong");
    expect(calendarConfidence(document.createElement("div"), "Team", true)).toBe("weak");
    row.removeChild(link);
    expect(calendarConfidence(row, "Team", false)).toBe("weak");
    expect(calendarFallbackKey("Team", "Owned")).not.toBe(calendarFallbackKey("Team", "Shared"));

    const calendars = [
      {
        key: "a",
        label: "Team",
        confidence: "medium" as const,
        ownership: "unknown" as const,
        visible: true,
      },
      {
        key: "b",
        label: "Team",
        confidence: "medium" as const,
        ownership: "unknown" as const,
        visible: true,
      },
    ];
    expect(resolveCalendarByLabel("Team", calendars)).toBeNull();
    expect(resolveCalendarByLabel("Missing", calendars)).toBeNull();
  });

  it("同一section内でIDのない同名calendarをweakにし、visibility操作対象から除外する", () => {
    const section = document.createElement("div");
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", "Owned calendars");
    for (const visible of ["true", "false"]) {
      const row = document.createElement("div");
      row.setAttribute("role", "listitem");
      const control = document.createElement("button");
      control.setAttribute("role", "checkbox");
      control.setAttribute("aria-label", "Team");
      control.setAttribute("aria-checked", visible);
      row.append(control);
      section.append(row);
    }
    document.body.append(section);

    const adapter = new GoogleCalendarDomAdapter(document);
    const calendars = adapter.listCalendars();
    expect(calendars).toHaveLength(2);
    expect(new Set(calendars.map(({ key }) => key)).size).toBe(1);
    expect(calendars.map(({ confidence }) => confidence)).toEqual(["weak", "weak"]);
    expect(adapter.getCalendarToggleElement(calendars[0]?.key ?? "")).toBeNull();
    section.remove();
  });

  it("Google Calendarの短縮形式の予定IDからカレンダーIDを復元する", () => {
    const encode = (value: string) =>
      btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");

    expect(decodeCalendarIdFromEventId(encode("event-id@gmail.com owner@m"))).toBe(
      "owner@gmail.com",
    );
    expect(
      decodeCalendarIdFromEventId(encode("event-id@gmail.com abcdef@group.calendar.google.com")),
    ).toBe("abcdef@group.calendar.google.com");
    expect(decodeCalendarIdFromEventId(encode("event-id@gmail.com owner@x"))).toBeNull();
    expect(decodeCalendarIdFromEventId("not-an-encoded-event-id")).toBeNull();
  });

  it("任意のdata-idをカレンダーIDとして扱わず、複数候補も拒否する", () => {
    const row = document.createElement("div");
    row.setAttribute("role", "listitem");
    const metadata = document.createElement("div");
    metadata.setAttribute("data-id", btoa("internal-button-id").replace(/=+$/gu, ""));
    row.append(metadata);
    expect(readCalendarId(row)).toBeNull();

    metadata.setAttribute("data-id", btoa("first@example.test").replace(/=+$/gu, ""));
    const second = document.createElement("span");
    second.setAttribute("data-id", btoa("second@example.test").replace(/=+$/gu, ""));
    row.append(second);
    expect(readCalendarId(row)).toBeNull();
  });
});

describe("Google Calendar DOM adaptation", () => {
  it("カレンダー操作ボタンをrole=listitem内のフレックス行へ配置する", () => {
    const list = document.createElement("div");
    list.setAttribute("role", "list");
    const row = document.createElement("li");
    row.setAttribute("role", "listitem");
    row.style.display = "flex";
    row.setAttribute("data-calendar-id", "primary@example.test");
    const flexRow = document.createElement("div");
    flexRow.style.display = "flex";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", "Primary");
    checkbox.checked = true;
    flexRow.append(checkbox, document.createTextNode("Primary"));
    row.append(flexRow);
    list.append(row);
    document.body.append(list);

    const adapter = new GoogleCalendarDomAdapter(document);
    const calendar = adapter.listCalendars()[0];
    expect(calendar).toBeDefined();
    expect(adapter.getCalendarControlContainer(calendar?.key ?? "")).toBe(flexRow);

    list.remove();
  });

  it("表示形式を含まないURLでも週表示を判定してtest予定2件を識別する", () => {
    document.documentElement.removeAttribute("data-calendar-view");
    const viewButton = document.createElement("button");
    viewButton.setAttribute("aria-haspopup", "menu");
    viewButton.textContent = "週 arrow_drop_down";
    document.body.append(viewButton);
    const encode = (value: string) =>
      btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
    const owners = [
      { id: "primary@gmail.com", encoded: "primary@m" },
      { id: "shared@example.test", encoded: "shared@example.test" },
    ];
    const fixture = readFileSync(resolve("tests/fixtures/gcal/week-live.html"), "utf8");
    let html = fixture;
    for (const [index, owner] of owners.entries()) {
      const calendarToken = ["PRIMARY", "SHARED"][index];
      const eventToken = ["EVENT_PRIMARY", "EVENT_SHARED"][index];
      if (!calendarToken || !eventToken) continue;
      html = html.replace(`__CALENDAR_${calendarToken}__`, encode(owner.id));
      html = html.replace(
        `__${eventToken}__`,
        encode(`event-${index}@google.com ${owner.encoded}`),
      );
    }
    document.body.insertAdjacentHTML("beforeend", html);

    const adapter = new GoogleCalendarDomAdapter(document);
    expect(adapter.getCurrentView()).toBe("week");
    const calendars = adapter.listCalendars();
    const events = adapter.listVisibleEvents();
    const groups = groupMergeCandidates(events);

    expect(calendars.map(({ key, confidence }) => [key, confidence])).toEqual([
      ["calendar:primary@gmail.com", "strong"],
      ["calendar:shared@example.test", "strong"],
    ]);
    expect(events).toHaveLength(2);
    expect(events.map(({ title, dateKey, layoutKey }) => [title, dateKey, layoutKey])).toEqual([
      ["test", "28999", "28999:1055:46"],
      ["test", "28999", "28999:1055:46"],
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members).toHaveLength(2);

    document.querySelector('[role="list"][aria-label="My calendars"]')?.remove();
    document.querySelector('[role="gridcell"][data-datekey="28999"]')?.remove();
    viewButton.remove();
  });

  it("匿名化した月表示DOMから時刻付き予定と終日予定を復元する", () => {
    document.documentElement.setAttribute("data-calendar-view", "month");
    const encode = (value: string) =>
      btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
    const owners = ["first@example.test", "second@example.test", "third@example.test"];
    const tokens = ["FIRST", "SECOND", "THIRD"];
    let html = readFileSync(resolve("tests/fixtures/gcal/month-live.html"), "utf8");
    for (const [index, owner] of owners.entries()) {
      const token = tokens[index];
      if (!token) continue;
      html = html.replace(`__CALENDAR_${token}__`, encode(owner));
      html = html.replace(`__EVENT_${token}__`, encode(`timed-event-${index}@google.com ${owner}`));
      html = html.replace(
        `__ALL_DAY_${token}__`,
        encode(`all-day-event-${index}@google.com ${owner}`),
      );
    }
    html = html.replace("__DATE_LABEL__", "october-eighth");
    document.body.insertAdjacentHTML("beforeend", html);

    const monthAdapter = new GoogleCalendarDomAdapter(document);
    monthAdapter.listCalendars();
    const events = monthAdapter.listVisibleEvents();
    const groups = groupMergeCandidates(events);
    const timedEvents = events.filter(({ title }) => title === "Planning");
    const allDayEvents = events.filter(({ title }) => title === "Birthday");

    expect(events).toHaveLength(6);
    expect(
      timedEvents.map(({ dateKey, start, end, allDay }) => [dateKey, start, end, allDay]),
    ).toEqual(Array(3).fill(["2026-10-08", "22:30", "23:00", false]));
    expect(
      allDayEvents.map(({ dateKey, start, end, allDay }) => [dateKey, start, end, allDay]),
    ).toEqual(Array(3).fill(["2026-10-08", "00:00", "24:00", true]));
    expect(groups).toHaveLength(2);
    expect(groups.map(({ members }) => members)).toHaveLength(2);

    document.querySelector('[role="list"][aria-label="My calendars"]')?.remove();
    document.querySelector('[role="gridcell"][aria-labelledby="october-eighth"]')?.remove();
  });

  it("匿名化したスケジュール表示DOMから時刻と折りたたみ可能な行を識別する", () => {
    document.documentElement.setAttribute("data-calendar-view", "schedule");
    const encode = (value: string) =>
      btoa(value).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
    const owners = ["first@example.test", "second@example.test", "third@example.test"];
    const tokens = ["FIRST", "SECOND", "THIRD"];
    let html = readFileSync(resolve("tests/fixtures/gcal/schedule-live.html"), "utf8");
    for (const [index, owner] of owners.entries()) {
      const token = tokens[index];
      if (!token) continue;
      html = html.replace(`__CALENDAR_${token}__`, encode(owner));
      html = html.replace(`__EVENT_${token}__`, encode(`event-${index}@google.com ${owner}`));
    }
    document.body.insertAdjacentHTML("beforeend", html);

    const adapter = new GoogleCalendarDomAdapter(document);
    adapter.listCalendars();
    const events = adapter.listVisibleEvents();
    const groups = groupMergeCandidates(events);
    const elements = [...document.querySelectorAll<HTMLElement>("[data-eventchip][data-eventid]")];
    const viewAdapter = createCalendarViewAdapters().get("schedule");
    const eventElements = new Map(events.map((event, index) => [event.ref, elements[index]!]));

    expect(events.map(({ title, dateKey, start, end }) => [title, dateKey, start, end])).toEqual(
      Array(3).fill(["Planning", "29000", "22:30", "23:00"]),
    );
    expect(groups).toHaveLength(1);
    expect(viewAdapter?.applyMergedGeometry(groups[0]?.members ?? [], eventElements)).toEqual({
      safe: true,
    });
    expect(
      elements.map((element) =>
        viewAdapter?.mergeVisibilityContainer(element)?.getAttribute("role"),
      ),
    ).toEqual(["row", "row", "row"]);

    document.querySelector('[role="list"][aria-label="My calendars"]')?.remove();
    document.querySelector('[role="rowgroup"][data-datekey="29000"]')?.remove();
  });
});

describe("表示合成", () => {
  it("calendar colorとopacity、Spotlight、Merge情報を一つのpresentationへ合成する", () => {
    const canonical = event({ calendarKey: "calendar-a", ownership: "mine" });
    const duplicate = event({ ref: "event-b", calendarKey: "calendar-b", domOrder: 1 });
    const group: MergeGroup = {
      key: "merge-key",
      canonical,
      members: [canonical, duplicate],
      calendarKeys: ["calendar-a", "calendar-b"],
    };
    const input = {
      event: duplicate,
      mergeGroup: group,
      calendars: new Map([
        ["calendar-a", { color: "#123456", opacity: 0.4 }],
        ["calendar-b", { opacity: 0.8 }],
      ]),
      nativeColors: new Map([
        ["calendar-a", "#000000"],
        ["calendar-b", "#abcdef"],
      ]),
      spotlightCalendarKeys: new Set(["calendar-b"]),
      spotlightActive: true,
    };

    expect(composeEventPresentation(input)).toEqual({
      backgroundColor: "#123456",
      backgroundOpacity: 0.4,
      spotlightFactor: 1,
      hiddenByMerge: true,
      mergedCalendarColors: ["#123456", "#abcdef"],
      mergedCount: 2,
    });
    expect(normalizeOpacity(-1)).toBe(0);
    expect(normalizeOpacity(1.5)).toBe(1);
    expect(normalizeOpacity(Number.NaN)).toBe(1);
  });

  it("Spotlight対象外の予定だけをdimする", () => {
    const presentation = composeEventPresentation({
      event: event(),
      calendars: new Map(),
      nativeColors: new Map(),
      spotlightCalendarKeys: new Set(["calendar-b"]),
      spotlightActive: true,
    });
    expect(presentation.spotlightFactor).toBe(0.18);
    expect(presentation.mergedCount).toBe(1);
  });
});

describe("Visibility transactions", () => {
  it("現在状態から変化するcalendarだけを選ぶ", () => {
    expect(
      visibilityChanges(
        new Map([
          ["a", true],
          ["b", false],
          ["c", true],
        ]),
        new Set(["b", "c"]),
      ),
    ).toEqual([
      { calendarKey: "a", visible: false },
      { calendarKey: "b", visible: true },
    ]);
    expect(
      groupVisibilityTarget(
        ["a", "b"],
        new Map([
          ["a", true],
          ["b", false],
        ]),
      ),
    ).toBe(false);
    expect(
      profileVisibilityChanges(
        { id: "p", name: "Profile", visibleCalendarKeys: ["a"] },
        new Map([
          ["a", false],
          ["b", true],
        ]),
      ),
    ).toEqual([
      { calendarKey: "a", visible: true },
      { calendarKey: "b", visible: false },
    ]);
  });

  it("複数Soloのあと最初のsnapshotを復元し、途中で追加されたcalendarを変更しない", () => {
    const transaction = new SoloVisibilityTransaction();
    const original = new Map([
      ["a", true],
      ["b", false],
    ]);
    expect(transaction.enter(new Set(["a"]), original)).toEqual([]);
    expect(
      transaction.enter(
        new Set(["b"]),
        new Map([
          ["a", true],
          ["b", false],
          ["c", true],
        ]),
      ),
    ).toEqual([
      { calendarKey: "a", visible: false },
      { calendarKey: "b", visible: true },
    ]);
    expect(
      transaction.restore(
        new Map([
          ["a", false],
          ["b", true],
          ["c", true],
        ]),
      ),
    ).toEqual([
      { calendarKey: "a", visible: true },
      { calendarKey: "b", visible: false },
    ]);
    expect(transaction.active).toBe(false);
  });

  it("Solo中に追加したcalendarは対象にするまで変更せず、対象にした後は表示状態を復元する", () => {
    const transaction = new SoloVisibilityTransaction();
    expect(
      transaction.enter(
        new Set(["a"]),
        new Map([
          ["a", true],
          ["b", true],
        ]),
      ),
    ).toEqual([{ calendarKey: "b", visible: false }]);
    expect(
      transaction.enter(
        new Set(["c"]),
        new Map([
          ["a", true],
          ["b", false],
          ["c", true],
        ]),
      ),
    ).toEqual([{ calendarKey: "a", visible: false }]);
    expect(
      transaction.restore(
        new Map([
          ["a", false],
          ["b", false],
          ["c", true],
        ]),
      ),
    ).toEqual([
      { calendarKey: "a", visible: true },
      { calendarKey: "b", visible: true },
    ]);
  });
});

describe("Settings migration", () => {
  it("古いversionを検証し、範囲外値を補正して安全なdefaultを返す", () => {
    expect(
      migrateSettings({
        schemaVersion: 0,
        mergeEnabled: false,
        calendars: {
          a: { color: "#ABCDEF", opacity: 2, groupId: "missing" },
          b: { opacity: Number.NaN },
        },
        groups: {},
        profiles: { p: { name: "  Work  ", visibleCalendarKeys: ["a", "a", "", 3] } },
        events: [{ title: "must not persist" }],
      }),
    ).toEqual({
      schemaVersion: 2,
      mergeEnabled: false,
      calendars: { a: { color: "#abcdef", opacity: 1 }, b: { opacity: 1 } },
      groups: {},
      profiles: { p: { id: "p", name: "Work", visibleCalendarKeys: ["a"] } },
    });
    expect(migrateSettings({ schemaVersion: 99 })).toEqual(createDefaultSettings());
    expect(migrateSettings(null)).toEqual(createDefaultSettings());
  });

  it("旧group.calendarKeysを移行時だけ読み取りcalendar preferencesを唯一の所属元にする", () => {
    expect(
      migrateSettings({
        schemaVersion: 1,
        calendars: {
          assigned: { opacity: 1 },
          authoritative: { opacity: 1, groupId: "second" },
        },
        groups: {
          first: { name: "First", calendarKeys: ["assigned", "authoritative"] },
          second: { name: "Second", calendarKeys: ["authoritative"] },
        },
      }),
    ).toMatchObject({
      schemaVersion: 2,
      calendars: {
        assigned: { opacity: 1, groupId: "first" },
        authoritative: { opacity: 1, groupId: "second" },
      },
      groups: {
        first: { id: "first", name: "First" },
        second: { id: "second", name: "Second" },
      },
    });
  });
});
