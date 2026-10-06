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
  } finally {
    await context.close();
  }
});
