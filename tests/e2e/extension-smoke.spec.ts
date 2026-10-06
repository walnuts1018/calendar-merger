import { chromium, expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("production extensionをChromiumに読み込んで週表示のtest予定をMergeする", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const extensionArgs = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ];
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: extensionArgs,
  });

  try {
    const page = await context.newPage();
    const encode = (value: string) => Buffer.from(value).toString("base64url");
    const owners = [
      { token: "PRIMARY", id: "primary@gmail.com", encoded: "primary@m" },
      { token: "SHARED", id: "shared@example.test", encoded: "shared@example.test" },
    ];
    let events = readFileSync(resolve("tests/fixtures/gcal/week-live.html"), "utf8");
    for (const [index, owner] of owners.entries()) {
      const eventToken = index === 0 ? "EVENT_PRIMARY" : "EVENT_SHARED";
      events = events.replace(`__CALENDAR_${owner.token}__`, encode(owner.id));
      events = events.replace(
        `__${eventToken}__`,
        encode(`test-event-${index}@google.com ${owner.encoded}`),
      );
    }
    const sharedOwner = owners[1];
    if (!sharedOwner) throw new Error("共有カレンダーfixtureがありません。");
    const sharedEventId = encode(`test-event-1@google.com ${sharedOwner.encoded}`);
    const sharedEventStart = events.indexOf(`data-eventid="${sharedEventId}"`);
    const sharedEventTop = events.indexOf("top: 1055px;", sharedEventStart);
    const sharedEventHeight = events.indexOf("height: 46px;", sharedEventTop);
    if (sharedEventStart < 0 || sharedEventTop < 0 || sharedEventHeight < 0)
      throw new Error("共有カレンダーの予定fixtureを特定できません。");
    events =
      events.slice(0, sharedEventTop) +
      events
        .slice(sharedEventTop)
        .replace("top: 1055px;", "top: 1056px;")
        .replace("height: 46px;", "height: 47px;");

    await page.route("https://calendar.google.com/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>Google Calendar</title></head><body><button aria-haspopup="menu">週 arrow_drop_down</button>${events}</body></html>`,
      }),
    );
    await page.goto("https://calendar.google.com/calendar/u/0/r");

    const calendarMerger = page.locator("calendar-merger-ui");
    await expect(calendarMerger).toBeAttached();
    const eventElements = page.locator("[data-eventchip][data-eventid]");
    await expect
      .poll(() =>
        eventElements.evaluateAll(
          (elements) =>
            elements.filter((element) => (element as HTMLElement).style.visibility === "hidden")
              .length,
        ),
      )
      .toBe(1);
    await expect(eventElements.first()).toHaveAttribute("style", /top: 1055px !important/);
    await expect(eventElements.first()).toHaveAttribute("style", /height: 48px !important/);
  } finally {
    await context.close();
  }
});
