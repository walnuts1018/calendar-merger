export type FrameWrite = () => void;

export class MutationPipeline {
  private readonly observer: MutationObserver;
  private readonly pendingRecords: MutationRecord[] = [];
  private frameHandle: number | undefined;
  private microtaskQueued = false;
  private initialScanPending = false;
  private disposed = false;
  private lastFrameDuration = 0;

  constructor(
    private readonly document: Document,
    private readonly prepareFrame: (
      dirtyNodes: ReadonlySet<Node>,
      positionedEvents: ReadonlySet<HTMLElement>,
    ) => FrameWrite | void,
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
      attributeOldValue: true,
      characterData: true,
      attributeFilter: [
        "aria-label",
        "aria-labelledby",
        "aria-checked",
        "class",
        "checked",
        "role",
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
        "data-id",
        "data-calendar-name",
        "data-calendar-owner",
        "data-all-day",
        "data-calendar-view",
        "data-datekey",
        "hidden",
        "style",
      ],
    });
    this.initialScanPending = true;
    this.queueMicrotask();
  }

  dispose(): void {
    this.disposed = true;
    this.observer.disconnect();
    if (this.frameHandle !== undefined)
      this.document.defaultView?.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.pendingRecords.length = 0;
  }

  get lastFrameDurationMs(): number {
    return this.lastFrameDuration;
  }

  private collect(records: MutationRecord[]): void {
    this.pendingRecords.push(...records);
    this.queueMicrotask();
  }

  private queueMicrotask(): void {
    if (this.microtaskQueued || this.disposed) return;
    this.microtaskQueued = true;
    queueMicrotask(() => {
      this.microtaskQueued = false;
      if (
        this.disposed ||
        this.frameHandle !== undefined ||
        (this.pendingRecords.length === 0 && !this.initialScanPending)
      )
        return;
      const window = this.document.defaultView;
      if (!window) return;
      this.frameHandle = window.requestAnimationFrame(() => this.flushFrame());
    });
  }

  private flushFrame(): void {
    this.frameHandle = undefined;
    if (this.disposed) return;
    const startedAt = this.document.defaultView?.performance.now() ?? 0;
    const records = this.pendingRecords.splice(0);
    const dirty = new Set<Node>();
    const positionedEvents = new Set<HTMLElement>();
    if (this.initialScanPending) {
      dirty.add(this.document.documentElement);
      this.initialScanPending = false;
    }
    const HTMLElement = this.document.defaultView?.HTMLElement;
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
        record.target.nodeType === 1 &&
        !this.isRelevantLayoutMutation(record.target as Element)
      )
        continue;
      if (
        record.type === "attributes" &&
        record.attributeName === "style" &&
        HTMLElement &&
        record.target instanceof HTMLElement &&
        inlinePositionChanged(record.target, record.oldValue, record.target.getAttribute("style"))
      )
        positionedEvents.add(record.target);
      const addedNodes = [...record.addedNodes].filter((node) => !isExtensionOwned(node));
      const removedNodes = [...record.removedNodes].filter((node) => !isExtensionOwned(node));
      if (record.type === "childList" && addedNodes.length === 0 && removedNodes.length === 0)
        continue;
      dirty.add(record.target);
      for (const node of addedNodes) dirty.add(node);
      for (const node of removedNodes) dirty.add(node);
    }
    if (dirty.size > 0) {
      const write = this.prepareFrame(dirty, positionedEvents);
      write?.();
    }
    const endedAt = this.document.defaultView?.performance.now() ?? startedAt;
    this.lastFrameDuration = Math.max(0, endedAt - startedAt);
    if (this.pendingRecords.length > 0) this.queueMicrotask();
  }
}

function inlinePositionChanged(
  element: HTMLElement,
  previous: string | null,
  current: string | null,
): boolean {
  const style = element.ownerDocument.createElement("div").style;
  style.cssText = previous ?? "";
  const previousPosition = ["left", "top"].map((property) => [
    style.getPropertyValue(property),
    style.getPropertyPriority(property),
  ]);
  style.cssText = current ?? "";
  const currentPosition = ["left", "top"].map((property) => [
    style.getPropertyValue(property),
    style.getPropertyPriority(property),
  ]);
  return JSON.stringify(previousPosition) !== JSON.stringify(currentPosition);
}

function isExtensionOwned(node: Node): boolean {
  const element =
    node.nodeType === 1 ? (node as Element) : node.nodeType === 3 ? node.parentElement : null;
  return Boolean(element?.closest("[data-gce-ui], [data-gce-overlay]"));
}
