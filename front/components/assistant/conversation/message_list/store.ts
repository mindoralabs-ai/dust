// Data store behind the conversation message list. It reproduces the
// imperative data API the conversation code was written against (append,
// map, batch...) on top of a plain array, so the list itself can be rendered
// by the MIT-licensed react-virtuoso.
//
// Mutations apply synchronously: callers read the data back immediately
// after changing it (e.g. `while (data.get().some(...)) data.findAndDelete(...)`).

export type ScrollAnimation = (
  currentTop: number,
  targetTop: number
) => { animationFrameCount: number; easing: (t: number) => number };

export type NativeScrollBehavior = "auto" | "instant" | "smooth";

// Custom animations run as native smooth scrolling.
export type ListScrollBehavior = NativeScrollBehavior | ScrollAnimation;

export type ItemAlign = "start" | "center" | "end" | "start-no-overflow";

export interface ItemLocationWithAlign {
  index: number | "LAST";
  align?: ItemAlign;
  behavior?: ListScrollBehavior;
  offset?: number;
}

// A number scrolls instantly to that item, aligned to the top.
export type ItemLocation = number | ItemLocationWithAlign;

export interface ListScrollLocation {
  // Distance from the scroller bottom edge to the viewport bottom edge; 0 at the bottom.
  bottomOffset: number;
  // True at the bottom, and while a smooth scroll to the bottom is running.
  isAtBottom: boolean;
  // Distance from the list top edge to the viewport top edge; 0 at the top,
  // negative once the list is scrolled down.
  listOffset: number;
  scrollHeight: number;
  // Viewport height without the sticky footer.
  visibleListHeight: number;
}

export interface AutoscrollParams<Data, Context> {
  // Whether the list was at the bottom before the change.
  atBottom: boolean;
  context: Context;
  // The data supplied by the operation: added items for append and insert,
  // the current data for other operations.
  data: Data[];
  scrollInProgress: boolean;
  // The location before the change is applied.
  scrollLocation: ListScrollLocation;
}

/**
 * @cc [owner:jchen0824,label:react] autoscroll-policy-semantics
 * `false` or no policy MUST keep the viewport. `true` (as `"auto"`) or a scroll behavior MUST
 * scroll to the bottom only when the list was at the bottom before the change. A callback MUST
 * receive the scroll location from before the change and decides alone: `false`, `null` or
 * `undefined` keep the viewport, `true` or a behavior scroll to the bottom even when scrolled up,
 * and a location scrolls to that item. The scroll runs once the changed data is rendered.
 */
export type AutoscrollToBottom<Data, Context> =
  | boolean
  | NativeScrollBehavior
  | ((
      params: AutoscrollParams<Data, Context>
    ) => boolean | NativeScrollBehavior | ItemLocation | null | undefined);

/**
 * @cc [owner:jchen0824,label:react] synchronous-data-methods
 * Every data method MUST apply its change before returning, so a `get`, `find` or `findIndex`
 * right after `append`, `insert`, `map`, `prepend`, `findAndDelete` or `batch` observes it.
 * Rendering and scrolling follow later.
 */
/**
 * @cc [owner:jchen0824,label:react] find-and-delete-removes-all-matches
 * `findAndDelete` MUST delete every item matching the predicate, not only the first.
 */
export interface MessageListDataMethods<Data, Context> {
  append(
    items: Data[],
    scrollToBottom?: AutoscrollToBottom<Data, Context>
  ): void;
  batch(
    callback: () => void,
    scrollToBottom?: AutoscrollToBottom<Data, Context>
  ): void;
  find(
    predicate: (item: Data, index: number, data: Data[]) => boolean
  ): Data | undefined;
  // Deletes every item matching the predicate.
  findAndDelete(predicate: (item: Data, index: number) => boolean): void;
  findIndex(
    predicate: (item: Data, index: number, data: Data[]) => boolean
  ): number;
  // Returns a shallow copy of the current data.
  get(): Data[];
  insert(
    items: Data[],
    offset: number,
    scrollToBottom?: AutoscrollToBottom<Data, Context>
  ): void;
  map(
    callback: (item: Data, index: number) => Data,
    scrollToBottom?: AutoscrollToBottom<Data, Context>
  ): void;
  // Adds items above the current ones while keeping the viewport in place.
  prepend(items: Data[]): void;
}

// What the store needs from the rendered list to evaluate scroll policies.
export interface MessageListView<Context> {
  // Called before rows are added or removed, while the DOM shows the old rows.
  beforeStructuralChange(): void;
  getContext(): Context;
  getScrollLocation(): ListScrollLocation;
  isScrollInProgress(): boolean;
  // Called after a data change whose scroll policy asked for no scroll.
  keepViewport(): void;
}

// react-virtuoso keeps the viewport stable on prepend when the first item
// index decreases by the number of prepended items. Start high enough that it
// never reaches zero.
export const INITIAL_FIRST_ITEM_INDEX = 1_000_000_000;

const DETACHED_LOCATION: ListScrollLocation = {
  bottomOffset: 0,
  isAtBottom: true,
  listOffset: 0,
  scrollHeight: 0,
  visibleListHeight: 0,
};

export function normalizeLocation(
  location: ItemLocation
): ItemLocationWithAlign {
  if (typeof location === "number") {
    return { index: location, align: "start", behavior: "instant" };
  }
  return location;
}

function bottomLocation(behavior: NativeScrollBehavior): ItemLocationWithAlign {
  return { index: "LAST", align: "end", behavior };
}

export class MessageListStore<Data, Context> {
  private items: Data[] = [];
  private version = 0;
  private listeners = new Set<() => void>();
  private batchDepth = 0;
  private changedDuringBatch = false;
  private pendingScroll: ItemLocationWithAlign | null = null;

  firstItemIndex = INITIAL_FIRST_ITEM_INDEX;
  view: MessageListView<Context> | null = null;
  // Called whenever a scroll is requested, so the list can perform it once
  // the data it targets is rendered.
  onScrollRequest: (() => void) | null = null;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  // The current array, without copying. Treat it as read-only: every
  // mutation replaces it.
  current(): Data[] {
    return this.items;
  }

  // Replaces the whole dataset, e.g. when the list is given new data.
  reset(items: Data[]): void {
    this.items = items.slice();
    this.firstItemIndex = INITIAL_FIRST_ITEM_INDEX;
    this.pendingScroll = null;
    this.changed();
  }

  // Scroll to perform once the latest data is rendered. The latest request wins.
  requestScroll(location: ItemLocation): void {
    this.pendingScroll = normalizeLocation(location);
    this.onScrollRequest?.();
  }

  takePendingScroll(): ItemLocationWithAlign | null {
    const location = this.pendingScroll;
    this.pendingScroll = null;
    return location;
  }

  // Scroll policies run after the synchronous data change: the scroll
  // location they read comes from the DOM, which still shows the previous data.
  readonly data: MessageListDataMethods<Data, Context> = {
    append: (items, scrollToBottom) => {
      this.commit([...this.items, ...items]);
      this.applyScrollPolicy(scrollToBottom, items);
      this.keepViewportUnlessScrolling();
    },
    batch: (callback, scrollToBottom) => {
      this.batchDepth += 1;
      try {
        callback();
      } finally {
        this.batchDepth -= 1;
      }
      if (this.batchDepth === 0) {
        this.applyScrollPolicy(scrollToBottom, this.items);
        if (this.changedDuringBatch) {
          this.changedDuringBatch = false;
          this.keepViewportUnlessScrolling();
          this.emit();
        }
      }
    },
    find: (predicate) => this.items.find(predicate),
    findAndDelete: (predicate) => {
      const next = this.items.filter((item, index) => !predicate(item, index));
      if (next.length !== this.items.length) {
        this.view?.beforeStructuralChange();
        this.commit(next);
      }
    },
    findIndex: (predicate) => this.items.findIndex(predicate),
    get: () => this.items.slice(),
    insert: (items, offset, scrollToBottom) => {
      const at = Math.max(0, Math.min(offset, this.items.length));
      this.view?.beforeStructuralChange();
      this.commit([
        ...this.items.slice(0, at),
        ...items,
        ...this.items.slice(at),
      ]);
      this.applyScrollPolicy(scrollToBottom, items);
      this.keepViewportUnlessScrolling();
    },
    map: (callback, scrollToBottom) => {
      const next = this.items.map(callback);
      const changed = next.some((item, index) => item !== this.items[index]);
      if (changed) {
        this.commit(next);
      }
      this.applyScrollPolicy(scrollToBottom, next);
      if (changed) {
        this.keepViewportUnlessScrolling();
      }
    },
    prepend: (items) => {
      if (items.length === 0) {
        return;
      }
      this.view?.beforeStructuralChange();
      this.firstItemIndex -= items.length;
      this.commit([...items, ...this.items]);
    },
  };

  private applyScrollPolicy(
    policy: AutoscrollToBottom<Data, Context> | undefined,
    data: Data[]
  ): void {
    if (policy === undefined || policy === false) {
      return;
    }
    const location = this.view?.getScrollLocation() ?? DETACHED_LOCATION;
    const atBottom = location.isAtBottom;

    if (typeof policy !== "function") {
      if (atBottom) {
        this.requestScroll(bottomLocation(policy === true ? "auto" : policy));
      }
      return;
    }

    if (!this.view) {
      return;
    }
    const decision = policy({
      atBottom,
      context: this.view.getContext(),
      data,
      scrollInProgress: this.view.isScrollInProgress(),
      scrollLocation: location,
    });
    if (decision === false || decision === null || decision === undefined) {
      return;
    }
    if (decision === true) {
      this.requestScroll(bottomLocation("auto"));
    } else if (typeof decision === "string") {
      this.requestScroll(bottomLocation(decision));
    } else {
      this.requestScroll(decision);
    }
  }

  // Without a requested scroll, a data change keeps the viewport, even at the
  // bottom. Inside a batch, the batch's policy decides once it ends.
  private keepViewportUnlessScrolling(): void {
    if (this.batchDepth === 0 && this.pendingScroll === null) {
      this.view?.keepViewport();
    }
  }

  private commit(next: Data[]): void {
    this.items = next;
    this.changed();
  }

  private changed(): void {
    this.version += 1;
    if (this.batchDepth > 0) {
      this.changedDuringBatch = true;
      return;
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
