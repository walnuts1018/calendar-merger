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
  readCalendarId,
  resolveCalendarByLabel,
} from "../../src/gcal/identity";
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

  it("同一カレンダーの重複、private placeholder、weak identityをまとめない", () => {
    const first = event();
    const sameCalendarDuplicate = event({ ref: "same-calendar", domOrder: 1 });
    const otherCalendarDuplicate = event({ ref: "other-calendar", calendarKey: "calendar-b" });
    const privateEvents = [
      event({ ref: "busy-a", title: "Busy" }),
      event({ ref: "busy-b", calendarKey: "calendar-b", title: "Busy" }),
      event({ ref: "private-a", title: "Private" }),
      event({ ref: "private-b", calendarKey: "calendar-b", title: "Private" }),
      event({ ref: "予定-a", title: "予定あり" }),
      event({ ref: "予定-b", calendarKey: "calendar-b", title: "予定あり" }),
    ];

    expect(
      groupMergeCandidates([first, sameCalendarDuplicate, otherCalendarDuplicate]),
    ).toHaveLength(0);
    expect(groupMergeCandidates(privateEvents)).toHaveLength(0);
    expect(createMergeKey(event({ calendarConfidence: "weak" }))).toBeNull();
    expect(createMergeKey(event({ eventConfidence: "weak" }))).toBeNull();
    expect(createMergeKey(event({ title: "Busy, October 6, 9:00 AM" }))).toBeNull();
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
        { id: "g", name: "Group", calendarKeys: ["a", "b"] },
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
      schemaVersion: 1,
      mergeEnabled: false,
      calendars: { a: { color: "#abcdef", opacity: 1 }, b: { opacity: 1 } },
      groups: {},
      profiles: { p: { id: "p", name: "Work", visibleCalendarKeys: ["a"] } },
    });
    expect(migrateSettings({ schemaVersion: 99 })).toEqual(createDefaultSettings());
    expect(migrateSettings(null)).toEqual(createDefaultSettings());
  });
});
