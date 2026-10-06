import { browser } from "wxt/browser";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";

import type { ApplicationHandle } from "../src/application";

import { mountCalendarMergerApplication } from "../src/application";
import { findCalendarListRoot } from "../src/gcal/calendar-root";

export default defineContentScript({
  matches: ["https://calendar.google.com/*"],
  runAt: "document_idle",
  world: "ISOLATED",
  async main(context) {
    if (document.querySelector("calendar-merger-ui")) return;
    let application: ApplicationHandle | undefined;
    let generation = 0;
    const ui = await createShadowRootUi(context, {
      name: "calendar-merger-ui",
      position: "inline",
      anchor: () => findCalendarListRoot(document),
      append: "after",
      onMount(container, _shadow, shadowHost) {
        shadowHost.setAttribute("data-gce-ui", "");
        shadowHost.style.setProperty("display", "block");
        shadowHost.style.setProperty("margin", "8px 0");
        const currentGeneration = ++generation;
        void mountCalendarMergerApplication(document, container, browser.storage.local)
          .then((mounted) => {
            if (currentGeneration !== generation || !shadowHost.isConnected) {
              mounted.dispose();
              return;
            }
            application = mounted;
          })
          .catch(() => undefined);
      },
      onRemove() {
        generation += 1;
        application?.dispose();
        application = undefined;
      },
    });
    const mountObserver = new MutationObserver(() => {
      if (ui.shadowHost.isConnected) return;
      if (!findCalendarListRoot(document)) {
        ui.remove();
        return;
      }
      ui.remove();
      ui.mount();
    });
    mountObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "aria-label",
        "aria-labelledby",
        "data-calendar-id",
        "data-calendarid",
        "data-calendar-key",
        "data-id",
        "role",
      ],
    });
    context.onInvalidated(() => mountObserver.disconnect());
    if (findCalendarListRoot(document)) ui.mount();
  },
});
