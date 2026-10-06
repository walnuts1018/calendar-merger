export type FrameWrite = () => void;

export class MutationPipeline {
  private readonly observer: MutationObserver;
  private readonly dirtyNodes = new Set<Node>();
  private frameHandle: number | undefined;
  private microtaskQueued = false;
  private disposed = false;
  private lastFrameDuration = 0;

  constructor(
    private readonly document: Document,
    private readonly prepareFrame: (dirtyNodes: ReadonlySet<Node>) => FrameWrite | void,
    private readonly isOwnStyleMutation: (element: HTMLElement) => boolean = () => false,
    private readonly isRelevantLayoutMutation: (element: Element) => boolean = () => true,
  ) {
    const Observer = document.defaultView?.MutationObserver;
    if (!Observer || !document.body)
      throw new Error("Calendar document is not ready for observation.");
    this.observer = new Observer((records) => this.collect(records));
  }

  start(): void {
    if (this.disposed) return;
    this.observer.observe(this.document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
      attributeFilter: [
        "aria-label",
        "aria-checked",
        "class",
        "checked",
        "data-start",
        "data-end",
        "data-event-title",
        "title",
        "data-eventid",
        "data-event-id",
        "data-gce-event",
        "data-calendar-id",
        "data-calendarid",
        "data-calendar-key",
        "data-calendar-name",
        "data-calendar-owner",
        "data-all-day",
        "data-calendar-view",
        "hidden",
        "style",
      ],
    });
    this.dirtyNodes.add(this.document.documentElement);
    this.queueMicrotask();
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    if (this.frameHandle !== undefined)
      this.document.defaultView?.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.dirtyNodes.clear();
  }

  get lastFrameDurationMs(): number {
    return this.lastFrameDuration;
  }

  private collect(records: MutationRecord[]): void {
    const HTMLElement = this.document.defaultView?.HTMLElement;
    const layoutRelevance = new Map<Element, boolean>();
    for (const record of records) {
      if (isExtensionOwned(record.target)) continue;
      if (
        record.type === "attributes" &&
        record.attributeName === "style" &&
        HTMLElement &&
        record.target instanceof HTMLElement &&
        this.isOwnStyleMutation(record.target)
      )
        continue;
      if (
        record.type === "attributes" &&
        (record.attributeName === "style" || record.attributeName === "class") &&
        record.target.nodeType === 1
      ) {
        const element = record.target as Element;
        let relevant = layoutRelevance.get(element);
        if (relevant === undefined) {
          relevant = this.isRelevantLayoutMutation(element);
          layoutRelevance.set(element, relevant);
        }
        if (!relevant) continue;
      }
      const addedNodes = [...record.addedNodes].filter((node) => !isExtensionOwned(node));
      const removedNodes = [...record.removedNodes].filter((node) => !isExtensionOwned(node));
      if (record.type === "childList" && addedNodes.length === 0 && removedNodes.length === 0)
        continue;
      this.dirtyNodes.add(record.target);
      for (const node of addedNodes) this.dirtyNodes.add(node);
      for (const node of removedNodes) this.dirtyNodes.add(node);
    }
    this.queueMicrotask();
  }

  private queueMicrotask(): void {
    if (this.microtaskQueued || this.disposed) return;
    this.microtaskQueued = true;
    queueMicrotask(() => {
      this.microtaskQueued = false;
      if (this.disposed || this.frameHandle !== undefined || this.dirtyNodes.size === 0) return;
      const window = this.document.defaultView;
      if (!window) return;
      this.frameHandle = window.requestAnimationFrame(() => this.flushFrame());
    });
  }

  private flushFrame(): void {
    this.frameHandle = undefined;
    if (this.disposed) return;
    const dirty = new Set(this.dirtyNodes);
    this.dirtyNodes.clear();
    const startedAt = this.document.defaultView?.performance.now() ?? 0;
    const write = this.prepareFrame(dirty);
    write?.();
    const endedAt = this.document.defaultView?.performance.now() ?? startedAt;
    this.lastFrameDuration = Math.max(0, endedAt - startedAt);
    if (this.dirtyNodes.size > 0) this.queueMicrotask();
  }
}

function isExtensionOwned(node: Node): boolean {
  const element =
    node.nodeType === 1 ? (node as Element) : node.nodeType === 3 ? node.parentElement : null;
  return Boolean(element?.closest("[data-gce-ui], [data-gce-overlay]"));
}
