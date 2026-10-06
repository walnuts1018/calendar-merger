import { browser } from "wxt/browser";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";

import type { ApplicationHandle } from "../src/application";

import { mountCalendarMergerApplication } from "../src/application";
import { findCalendarListRoot, isCalendarListMutationCandidate } from "../src/gcal/calendar-root";

export default defineContentScript({
  matches: ["https://calendar.google.com/*"],
  runAt: "document_idle",
  world: "ISOLATED",
  async main(context) {
    if (document.querySelector("calendar-merger-ui")) return;
    let application: ApplicationHandle | undefined;
    let mountedRoot: HTMLElement | null = null;
    let generation = 0;
    const ui = await createShadowRootUi(context, {
      name: "calendar-merger-ui",
      position: "inline",
      anchor: () => findCalendarListRoot(document),
      append: "after",
      onMount(container, _shadow, shadowHost) {
        mountedRoot = findCalendarListRoot(document);
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
        mountedRoot = null;
        application?.dispose();
        application = undefined;
      },
    });
    const mountObserver = new MutationObserver((records) => {
      const currentRoot = mountedRoot;
      const hostConnected = ui.shadowHost.isConnected;
      const shouldSearch = records.some((record) => {
        const target = record.target.nodeType === 1 ? (record.target as Element) : null;
        if (target?.closest("[data-gce-ui], [data-gce-overlay]")) return false;
        const removedRoot = [...record.removedNodes].some(
          (node) => node === currentRoot || Boolean(currentRoot && node.contains(currentRoot)),
        );
        if (removedRoot) return true;

        if (hostConnected && currentRoot?.isConnected) {
          if (target === currentRoot) return record.type === "attributes";
          if (
            target?.contains(currentRoot) &&
            target !== document.body &&
            target !== document.documentElement
          )
            return record.type === "attributes";
          return [...record.addedNodes].some(
            (node) => !currentRoot.contains(node) && isCalendarListMutationCandidate(node),
          );
        }

        if (target && isCalendarListMutationCandidate(target)) return true;
        return [...record.addedNodes, ...record.removedNodes].some(isCalendarListMutationCandidate);
      });
      if (!shouldSearch) return;

      const nextRoot = findCalendarListRoot(document);
      if (nextRoot === currentRoot && hostConnected) return;
      if (!nextRoot) {
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
