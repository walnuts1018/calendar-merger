import { expect, test } from "@playwright/test";

const panelTrigger = "設定パネルを開く";
const mergeToggle = "Mergeの有効状態を切り替える";

async function openPanel(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByRole("button", { name: panelTrigger })).toBeVisible();
  await page.getByRole("button", { name: panelTrigger }).click();
  await expect(page.getByRole("button", { name: mergeToggle })).toBeEnabled();
}

function nativeCalendar(page: import("@playwright/test").Page, calendarId: string) {
  return page.locator(`[data-fixture-calendar-toggle="${calendarId}"]`);
}

test("calendarごとの配色、opacity、group visibilityを操作する", async ({ page }) => {
  await openPanel(page);
  const targetEvent = page.locator(
    '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-1"]',
  );
  await page.getByRole("button", { name: "Calendar Aの色と透明度を設定" }).click();
  await page.getByLabel("Calendar Aの色", { exact: true }).fill("#123456");
  await expect
    .poll(() => targetEvent.evaluate((element) => (element as HTMLElement).style.backgroundColor))
    .toBe("rgb(18, 52, 86)");

  const opacity = page.getByLabel("Calendar Aの透明度");
  await opacity.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "0.4";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect
    .poll(() => targetEvent.evaluate((element) => (element as HTMLElement).style.backgroundColor))
    .toBe("rgba(18, 52, 86, 0.4)");
  await page.getByRole("button", { name: "Calendar Aの色と透明度をリセット" }).click();
  await expect
    .poll(() => targetEvent.evaluate((element) => (element as HTMLElement).style.backgroundColor))
    .toBe("rgb(66, 133, 244)");

  await page.getByLabel("グループ名").fill("Team");
  await page.getByRole("button", { name: "グループを作成" }).click();
  await page.getByLabel("Calendar Aのグループ").selectOption({ label: "Team" });
  await page.getByLabel("Calendar Bのグループ").selectOption({ label: "Team" });
  await page.getByRole("button", { name: "Teamの表示を切り替える" }).click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "false");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "false");
  await expect(nativeCalendar(page, "calendar-3")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Teamの表示を切り替える" }).click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "true");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "true");
});

test("Merge中のstyle変更で予定geometryを維持する", async ({ page }) => {
  await openPanel(page);
  const canonical = page.locator(
    '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-1"]',
  );
  const originalGeometry = await canonical.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    return { width: htmlElement.style.width, height: htmlElement.style.height };
  });
  expect(originalGeometry.width).not.toBe("");

  await canonical.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    htmlElement.style.width = "120px";
    htmlElement.style.height = "16px";
    htmlElement.classList.add("gce-test-hover-layout");
  });
  await expect
    .poll(() =>
      canonical.evaluate((element) => ({
        width: (element as HTMLElement).style.width,
        height: (element as HTMLElement).style.height,
      })),
    )
    .toEqual(originalGeometry);

  await canonical.evaluate((element) => element.classList.remove("gce-test-hover-layout"));
  await expect
    .poll(() =>
      canonical.evaluate((element) => ({
        width: (element as HTMLElement).style.width,
        height: (element as HTMLElement).style.height,
      })),
    )
    .toEqual(originalGeometry);
});

test("groupを管理し、group SoloとSpotlightを操作する", async ({ page }) => {
  await openPanel(page);
  const inlineCalendarControls = page
    .locator('[data-fixture-calendar-toggle="calendar-1"]')
    .locator("xpath=..")
    .locator("[data-gce-calendar-controls]");
  await inlineCalendarControls
    .getByRole("button", { name: "Calendar Aの色と透明度を設定" })
    .click();
  await page
    .locator("[data-gce-calendar-controls-panel]")
    .getByRole("button", { name: "Calendar Aだけを表示" })
    .click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "true");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Solo表示を解除" }).click();
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "true");

  await page.getByLabel("グループ名").fill("Team");
  await page.getByRole("button", { name: "グループを作成" }).click();
  await page.getByLabel("Calendar Aのグループ").selectOption({ label: "Team" });
  await page.getByLabel("Calendar Bのグループ").selectOption({ label: "Team" });

  await page.getByRole("button", { name: "Teamだけを表示" }).click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "true");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "true");
  await expect(nativeCalendar(page, "calendar-3")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Solo表示を解除" }).click();
  await expect(nativeCalendar(page, "calendar-3")).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "TeamをSpotlight" }).hover();
  await expect(
    page.locator(
      '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-1"]',
    ),
  ).toHaveCSS("opacity", "1");
  await expect(
    page.locator('[data-fixture-view="week"] [data-event-title="Focus block"]'),
  ).toHaveCSS("opacity", "0.18");
  await page.getByRole("button", { name: "week", exact: true }).hover();

  await page.getByLabel("グループ「Team」の名前").fill("Project Team");
  await page.getByRole("button", { name: "Teamの名前を変更" }).click();
  await expect(page.getByRole("button", { name: "Project Teamの表示を切り替える" })).toBeVisible();
  await page.getByRole("button", { name: "Project Teamを削除" }).click();
  await expect(page.getByRole("button", { name: "Project Teamの表示を切り替える" })).toHaveCount(0);
});

test("同名Groupの編集draftを個別に保持する", async ({ page }) => {
  await openPanel(page);
  await page.getByLabel("グループ名").fill("Team");
  await page.getByRole("button", { name: "グループを作成" }).click();
  await page.getByLabel("グループ名").fill("Team");
  await page.getByRole("button", { name: "グループを作成" }).click();

  const drafts = page.locator('input[data-gce-draft-key^="group:"]');
  await expect(drafts).toHaveCount(2);
  const keys = await drafts.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-gce-draft-key")),
  );
  await drafts.nth(0).fill("First draft");
  await drafts.nth(1).fill("Second draft");

  await page.getByLabel("Calendar Aのグループ").selectOption({ label: "Team" });
  await expect(page.locator(`[data-gce-draft-key="${keys[0]}"]`)).toHaveValue("First draft");
  await expect(page.locator(`[data-gce-draft-key="${keys[1]}"]`)).toHaveValue("Second draft");
});

test("profileを更新し、連続Soloと解除で最初のvisibilityへ戻す", async ({ page }) => {
  await openPanel(page);
  await page.getByLabel("プロファイル名").fill("Team view");
  await page.getByRole("button", { name: "現在の表示をプロファイルとして保存" }).click();

  await nativeCalendar(page, "calendar-1").click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Team viewを適用" }).click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "true");

  await nativeCalendar(page, "calendar-2").click();
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "false");
  await page.getByRole("button", { name: "Team viewを現在の表示に更新" }).click();
  await nativeCalendar(page, "calendar-2").click();
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Team viewを適用" }).click();
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "false");

  const profileName = page.getByLabel("プロファイル「Team view」の名前");
  await profileName.fill("Renamed view");
  await expect(profileName).toHaveValue("Renamed view");
  await page.getByRole("button", { name: "Team viewの名前を変更" }).click();
  await expect(page.getByRole("button", { name: "Renamed viewを適用" })).toBeVisible();
  await page.getByRole("button", { name: "Renamed viewを削除" }).click();
  await expect(page.getByRole("button", { name: "Renamed viewを適用" })).toHaveCount(0);

  await page.getByRole("button", { name: "Calendar Aだけを表示" }).click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "true");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "false");
  await expect(nativeCalendar(page, "calendar-3")).toHaveAttribute("aria-checked", "false");

  await page.getByRole("button", { name: "Calendar Bだけを表示" }).click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "false");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Solo表示を解除" }).click();
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "true");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "false");
  await expect(nativeCalendar(page, "calendar-3")).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Calendar Aだけを表示" }).click();
  await expect(nativeCalendar(page, "calendar-3")).toHaveAttribute("aria-checked", "false");
  await page.evaluate(() => window.calendarMergerApp?.dispose());
  await expect(nativeCalendar(page, "calendar-1")).toHaveAttribute("aria-checked", "true");
  await expect(nativeCalendar(page, "calendar-2")).toHaveAttribute("aria-checked", "false");
  await expect(nativeCalendar(page, "calendar-3")).toHaveAttribute("aria-checked", "true");
});

test("Spotlight、全viewの安全なMerge、再描画後の復元を扱う", async ({ page }) => {
  await openPanel(page);
  const weekly = page.locator(
    '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-1"]',
  );
  await expect(page.locator('[data-gce-overlay="merge-count"]')).toHaveCount(0);
  await expect
    .poll(() => weekly.evaluate((element) => Number.parseFloat(getComputedStyle(element).width)))
    .toBeGreaterThan(200);
  await page
    .locator(
      '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-3"]',
    )
    .evaluate((element) => {
      (element as HTMLElement).style.left = "204px";
    });
  await expect
    .poll(() => weekly.evaluate((element) => (element as HTMLElement).style.width))
    .toBe("300px");
  await page.addStyleTag({
    content:
      '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-3"].gce-test-width { width: 128px !important; }',
  });
  await page
    .locator(
      '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-3"]',
    )
    .evaluate((element) => {
      element.classList.add("gce-test-width");
    });
  await expect
    .poll(() => weekly.evaluate((element) => (element as HTMLElement).style.width))
    .toBe("300px");
  await page.getByRole("button", { name: "Next period" }).click();
  await expect(page.locator('[data-gce-overlay="merge-count"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Previous period" }).click();
  await expect(page.locator('[data-gce-overlay="merge-count"]')).toHaveCount(0);
  const tenCalendarEvent = page.locator(
    '[data-fixture-view="week"] [data-event-title="Town Hall"][data-calendar-id="calendar-1"]',
  );
  await expect(tenCalendarEvent.locator(':scope > [data-gce-overlay="merge-count"]')).toHaveCount(
    0,
  );
  await expect
    .poll(() =>
      tenCalendarEvent.evaluate((element) => Number.parseFloat(getComputedStyle(element).width)),
    )
    .toBeGreaterThan(900);
  await expect(
    page.locator(
      '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-2"]',
    ),
  ).toHaveCSS("visibility", "hidden");
  const unsafeLayoutEvents = page.locator(
    '[data-fixture-view="week"] [data-event-title="Unsafe layout"]',
  );
  await expect(unsafeLayoutEvents).toHaveCount(2);
  await expect(unsafeLayoutEvents.nth(0)).toHaveCSS("visibility", "visible");
  await expect(unsafeLayoutEvents.nth(1)).toHaveCSS("visibility", "visible");

  await page.getByRole("button", { name: "Calendar AをSpotlight" }).hover();
  await expect(
    page.locator('[data-fixture-view="week"] [data-event-title="Focus block"]'),
  ).toHaveCSS("opacity", "0.18");
  await page.getByRole("button", { name: "week", exact: true }).hover();
  await expect(
    page.locator('[data-fixture-view="week"] [data-event-title="Focus block"]'),
  ).toHaveCSS("opacity", "1");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect
    .poll(() =>
      page
        .locator("#extension-host .gce-panel")
        .evaluate((element) => getComputedStyle(element).backgroundColor),
    )
    .toBe("rgb(41, 42, 45)");
  for (const view of ["day", "month", "schedule", "year"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    const title =
      view === "day"
        ? "Daily standup"
        : view === "month"
          ? "Product launch"
          : view === "schedule"
            ? "Same title"
            : "Holiday";
    const canonical = page.locator(
      `[data-fixture-view="${view}"] [data-event-title="${title}"][data-calendar-id="calendar-1"]`,
    );
    await expect(canonical.locator(':scope > [data-gce-overlay="merge-count"]')).toHaveCount(0);
  }

  await page.getByRole("button", { name: "week", exact: true }).click();
  await expect(tenCalendarEvent.locator(':scope > [data-gce-overlay="merge-count"]')).toHaveCount(
    0,
  );
  await page.evaluate(() => {
    const event = document.querySelector<HTMLElement>(
      '[data-fixture-view="week"] [data-event-title="Town Hall"][data-calendar-id="calendar-2"]',
    );
    if (event) event.replaceWith(event.cloneNode(true));
  });
  await expect(tenCalendarEvent.locator(':scope > [data-gce-overlay="merge-count"]')).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: mergeToggle }).click();
  const mergeOff = page.getByRole("button", { name: mergeToggle });
  await expect(mergeOff).toHaveText("Merge: Off");
  await expect(page.locator('[data-gce-overlay="merge-count"]')).toHaveCount(0);
  await expect(weekly).toHaveCSS("width", "96px");
  await expect(
    page.locator(
      '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-2"]',
    ),
  ).toHaveCSS("visibility", "visible");
  await page.getByRole("button", { name: mergeToggle }).click();
  await expect(page.getByRole("button", { name: mergeToggle })).toHaveText("Merge: On");
  await expect(page.locator('[data-gce-overlay="merge-count"]')).toHaveCount(0);
  await page.evaluate(() => window.calendarMergerApp?.dispose());
  await expect(page.getByRole("button", { name: panelTrigger })).toHaveCount(0);
  await expect(weekly).toHaveCSS("width", "96px");
  await expect(weekly).toHaveCSS("background-color", "rgb(66, 133, 244)");
  await expect(
    page.locator(
      '[data-fixture-view="week"] [data-event-title="Weekly Design"][data-calendar-id="calendar-2"]',
    ),
  ).toHaveCSS("visibility", "visible");
});

test("calendar listの追加、削除、sidebar再描画を追跡する", async ({ page }) => {
  await openPanel(page);
  await page.getByRole("button", { name: "Rerender sidebar" }).click();
  await page.getByRole("button", { name: "Calendar Jの色と透明度を設定" }).click();
  await expect(page.getByLabel("Calendar Jの色", { exact: true })).toBeVisible();
  await page.getByLabel("Calendar Jの色", { exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Calendar Jの色", { exact: true })).toBeHidden();

  await page.getByRole("button", { name: "Add calendar" }).click();
  await expect(
    page.locator('#calendar-sidebar [data-fixture-calendar-row][data-calendar-id="calendar-11"]'),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Calendar Kの色と透明度を設定" }).click();
  await expect(page.getByLabel("Calendar Kの色", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    document.querySelector('[data-calendar-id="calendar-11"]')?.remove();
  });
  await expect(page.getByLabel("Calendar Kの色", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Calendar Jの色と透明度を設定" }).click();
  await expect(page.getByLabel("Calendar Jの色", { exact: true })).toBeVisible();
});
