import { afterEach, describe, expect, it } from "vitest";

import type { CalendarGroup } from "../../src/domain/model";
import type {
  LocalStorageArea,
  StorageChangeEvent,
  StorageChangeListener,
} from "../../src/storage/settings";

import { mountCalendarMergerApplication } from "../../src/application";
import { SettingsRepository, settingsStorageKey } from "../../src/storage/settings";

class SharedStorage implements LocalStorageArea {
  private readonly values = new Map<string, unknown>();
  private readonly listeners = new Set<StorageChangeListener>();
  readonly onChanged: StorageChangeEvent = {
    addListener: (listener) => this.listeners.add(listener),
    removeListener: (listener) => this.listeners.delete(listener),
  };

  async get(key: string): Promise<Record<string, unknown>> {
    return this.values.has(key) ? { [key]: this.values.get(key) } : {};
  }

  async set(items: Record<string, unknown>): Promise<void> {
    await Promise.resolve();
    const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
    for (const [key, newValue] of Object.entries(items)) {
      const oldValue = this.values.get(key);
      this.values.set(key, newValue);
      changes[key] = { oldValue, newValue };
    }
    for (const listener of this.listeners) listener(changes, "local");
  }
}

afterEach(() => {
  document.body.replaceChildren();
  delete (document.defaultView as (Window & { chrome?: unknown }) | null)?.chrome;
});

describe("設定の複数タブ同期", () => {
  it("別calendarの同時更新をそれぞれ保持する", async () => {
    const storage = new SharedStorage();
    const firstTab = new SettingsRepository(storage);
    const secondTab = new SettingsRepository(storage);
    const [firstSettings, secondSettings] = await Promise.all([firstTab.load(), secondTab.load()]);
    firstSettings.calendars["calendar:first"] = { color: "#123456", opacity: 0.7 };
    secondSettings.calendars["calendar:second"] = { color: "#abcdef", opacity: 0.4 };

    await Promise.all([firstTab.save(firstSettings), secondTab.save(secondSettings)]);

    const reader = new SettingsRepository(storage);
    const loaded = await reader.load(["calendar:first", "calendar:second"]);
    expect(loaded.calendars).toEqual({
      "calendar:first": { color: "#123456", opacity: 0.7 },
      "calendar:second": { color: "#abcdef", opacity: 0.4 },
    });
    expect(await storage.get(settingsStorageKey)).toEqual({});
  });

  it("別tabの設定変更を開いているpanelへ反映する", async () => {
    const storage = new SharedStorage();
    document.body.innerHTML = `
      <aside>
        <h2 id="calendar-heading">My calendars</h2>
        <div role="list" aria-labelledby="calendar-heading">
          <div role="listitem" data-calendar-id="alpha@example.test">
            <div>
              <button role="checkbox" aria-label="Alpha" aria-checked="true"></button>
              <span style="background-color: rgb(18, 52, 86)"></span>
            </div>
          </div>
        </div>
      </aside>
      <div id="extension-panel"></div>
    `;
    const window = document.defaultView;
    const uiContainer = document.querySelector<HTMLElement>("#extension-panel");
    if (!window || !uiContainer) throw new Error("Fixture DOMを初期化できませんでした。");
    Object.defineProperty(window, "chrome", {
      configurable: true,
      value: { storage: { onChanged: storage.onChanged } },
    });

    const application = await mountCalendarMergerApplication(document, uiContainer, storage);
    const trigger = uiContainer.querySelector<HTMLButtonElement>(
      'button[aria-label="設定パネルを開く"]',
    );
    if (!trigger) throw new Error("設定panelが表示されませんでした。");
    trigger.click();

    const externalRepository = new SettingsRepository(storage);
    const externalSettings = await externalRepository.load(["calendar:alpha@example.test"]);
    const group: CalendarGroup = { id: "work", name: "Work" };
    externalSettings.groups[group.id] = group;
    await externalRepository.save(externalSettings);

    await waitFor(() =>
      [...uiContainer.querySelectorAll<HTMLInputElement>("input")].find(
        (input) => input.getAttribute("aria-label") === "グループ「Work」の名前",
      ),
    );
    expect(uiContainer.textContent).toContain("Work");

    externalSettings.calendars["calendar:alpha@example.test"] = {
      color: "#abcdef",
      opacity: 0.6,
    };
    await externalRepository.save(externalSettings);
    await waitFor(() => {
      const color = document
        .querySelector<HTMLElement>("[data-gce-calendar-controls-panel]")
        ?.shadowRoot?.querySelector<HTMLInputElement>('input[type="color"]')?.value;
      return color === "#abcdef" ? color : undefined;
    });

    application.dispose();
  });
});

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("期待したpanel更新が時間内に反映されませんでした。");
}
