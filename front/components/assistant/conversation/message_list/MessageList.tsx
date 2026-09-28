// Conversation message list built on the MIT-licensed react-virtuoso.
//
// It exposes the component, hooks and imperative methods the conversation code
// uses (VirtuosoMessageList, useVirtuosoMethods, useVirtuosoLocation...), so
// the self-hosted build does not depend on the commercial
// @virtuoso.dev/message-list package.
//
// Layout: the root element is the scroller (or the window with
// `useWindowScroll`). It holds the react-virtuoso list followed by the sticky
// footer, so "the bottom" is the maximum scroll position, where the last item
// ends just above the footer.
import type {
  AutoscrollToBottom,
  ItemAlign,
  ItemLocation,
  ItemLocationWithAlign,
  ListScrollBehavior,
  ListScrollLocation,
  MessageListDataMethods,
  NativeScrollBehavior,
} from "@app/components/assistant/conversation/message_list/store";
import {
  MessageListStore,
  normalizeLocation,
} from "@app/components/assistant/conversation/message_list/store";
import { assertNeverAndIgnore } from "@app/types/shared/utils/assert_never";
import type {
  ComponentType,
  CSSProperties,
  ForwardedRef,
  HTMLAttributes,
  Key,
  ReactElement,
  ReactNode,
  Ref,
  RefObject,
} from "react";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ContextProp,
  ItemProps,
  ListItem,
  VirtuosoHandle,
} from "react-virtuoso";
import { Virtuoso } from "react-virtuoso";

export type {
  AutoscrollToBottom,
  ItemLocation,
  ListScrollBehavior,
  ListScrollLocation,
  MessageListDataMethods,
};

export interface ItemContentProps<Data, Context> {
  context: Context;
  data: Data;
  index: number;
  nextData: Data | null;
  prevData: Data | null;
}

export interface ContextAwareProps<Context> {
  context: Context;
}

export interface VirtuosoMessageListMethods<Data, Context = unknown> {
  data: MessageListDataMethods<Data, Context>;
  getScrollLocation(): ListScrollLocation;
  // Measured height of the item, or an estimate while it is not rendered.
  height(item: Data): number;
  // Runs once the latest data is rendered.
  scrollToItem(location: ItemLocation): void;
}

export interface DataWithScrollModifier<Data> {
  data?: Data[] | null;
  // Applied when `data` changes.
  scrollModifier?: {
    location: ItemLocation;
    purgeItemSizes?: boolean;
    type: "item-location";
  } | null;
}

export interface VirtuosoMessageListProps<Data, Context>
  extends Omit<HTMLAttributes<HTMLDivElement>, "children" | "onScroll"> {
  computeItemKey?: (params: {
    context: Context;
    data: Data;
    index: number;
  }) => Key;
  context: Context;
  // Replacing `data.data` with a new array resets the list.
  data?: DataWithScrollModifier<Data> | null;
  EmptyPlaceholder?: ComponentType<ContextAwareProps<Context>>;
  // Keeps the sticky footer at the bottom of the viewport when the list is short.
  enforceStickyFooterAtBottom?: boolean;
  increaseViewportBy?: number;
  ItemContent?: ComponentType<ItemContentProps<Data, Context>>;
  // Identifies an item across data updates. Defaults to the item itself.
  itemIdentity?: (item: Data) => unknown;
  onRenderedDataChange?: (data: Data[]) => void;
  onScroll?: (location: ListScrollLocation) => void;
  shortSizeAlign?: "top" | "bottom" | "bottom-smooth";
  StickyFooter?: ComponentType<ContextAwareProps<Context>>;
  useWindowScroll?: boolean;
}

// Stay at the bottom this many frames after an instant scroll to it, while
// newly rendered items replace react-virtuoso's size estimates.
const SETTLE_FRAMES = 8;
// Resizes do not pull the viewport back to the bottom right after the user
// starts scrolling, before the scroll event is processed.
const USER_SCROLL_GRACE_MS = 150;
// Frames spent keeping the first visible item in place after rows are added
// or removed above it.
const ANCHOR_RESTORE_FRAMES = 12;
// A smooth scroll is over once the position is unchanged for this many frames.
const SCROLL_END_STABLE_FRAMES = 3;
const SCROLL_END_TIMEOUT_MS = 1500;

const DETACHED_LOCATION: ListScrollLocation = {
  bottomOffset: 0,
  isAtBottom: true,
  listOffset: 0,
  scrollHeight: 0,
  visibleListHeight: 0,
};

function sameLocation(a: ListScrollLocation, b: ListScrollLocation): boolean {
  return (
    a.bottomOffset === b.bottomOffset &&
    a.isAtBottom === b.isAtBottom &&
    a.listOffset === b.listOffset &&
    a.scrollHeight === b.scrollHeight &&
    a.visibleListHeight === b.visibleListHeight
  );
}

function toNativeBehavior(
  behavior: ListScrollBehavior | undefined
): NativeScrollBehavior {
  if (typeof behavior === "function") {
    return "smooth";
  }
  return behavior ?? "instant";
}

type ListAlign = "start" | "center" | "end";

function toListAlign(align: ItemAlign | undefined): ListAlign {
  switch (align) {
    case undefined:
    case "start":
    case "start-no-overflow":
      return "start";
    case "center":
    case "end":
      return align;
    default:
      assertNeverAndIgnore(align);
      return "start";
  }
}

// Scroll position that aligns an item spanning [top, top + height] within
// `visible` pixels of viewport.
function alignedScrollTop(
  align: ListAlign,
  top: number,
  height: number,
  visible: number
): number {
  switch (align) {
    case "start":
      return top;
    case "center":
      return top + height / 2 - visible / 2;
    case "end":
      return top + height - visible;
    default:
      assertNeverAndIgnore(align);
      return top;
  }
}

// How far an aligned item must stay clear of the sticky footer.
function footerClearance(align: ListAlign, footerHeight: number): number {
  switch (align) {
    case "start":
      return 0;
    case "center":
      return footerHeight / 2;
    case "end":
      return footerHeight;
    default:
      assertNeverAndIgnore(align);
      return 0;
  }
}

const SCROLL_KEYS = new Set([
  " ",
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
]);

// Wheel and touch moves always scroll. Keys count only outside the footer and
// editable fields, and a press only on the scroller itself (its scrollbar), so
// typing in the input bar never looks like the user scrolling away.
function isScrollIntent(
  event: Event,
  scroller: HTMLElement | null,
  footer: HTMLElement | null
): boolean {
  switch (event.type) {
    case "wheel":
    case "touchmove":
      return true;
    case "keydown": {
      const target = event.target;
      const inFooterOrField =
        target instanceof Element &&
        ((footer?.contains(target) ?? false) ||
          target.closest("input, textarea, select, [contenteditable]") !==
            null);
      return (
        event instanceof KeyboardEvent &&
        SCROLL_KEYS.has(event.key) &&
        !inFooterOrField
      );
    }
    case "pointerdown":
      return scroller !== null && event.target === scroller;
    default:
      return false;
  }
}

class LocationSource {
  private value: ListScrollLocation = DETACHED_LOCATION;
  private listeners = new Set<() => void>();

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly get = (): ListScrollLocation => this.value;

  set(next: ListScrollLocation): void {
    if (sameLocation(this.value, next)) {
      return;
    }
    this.value = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface ScrollMetrics {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  viewportTop: number;
}

// Owns scrolling: reading the location, performing scroll requests once the
// data they target is rendered, and keeping the bottom in view.
class ListController<Data, Context> {
  readonly store: MessageListStore<Data, Context>;
  readonly location: LocationSource;
  readonly methods: VirtuosoMessageListMethods<Data, Context>;

  scroller: HTMLElement | null = null;
  list: HTMLElement | null = null;
  footer: HTMLElement | null = null;
  virtuoso: VirtuosoHandle | null = null;
  windowMode = false;
  context: Context;
  identity: (item: Data) => unknown = (item) => item;
  onScroll: ((location: ListScrollLocation) => void) | undefined;
  onRenderedDataChange: ((data: Data[]) => void) | undefined;
  // onScroll stays silent until the initial position is applied.
  initialized = false;
  renderedVersion = -1;

  // The running programmatic smooth scroll, if any.
  private smoothScroll: { token: number; toBottom: boolean } | null = null;
  private scrollToken = 0;
  private lastUserScrollAtMs = 0;
  // Whether content resizes keep the viewport at the bottom. Only scrolling
  // (the user's or the list's) changes it.
  private pinnedToBottom = false;
  // The first visible item before rows were added or removed, kept in place
  // once the change is rendered.
  private changeAnchor: {
    capturedAtMs: number;
    identity: unknown;
    offset: number;
  } | null = null;
  // The first visible item at the last scroll, restored when the scroll mode
  // changes and the list remounts.
  private viewAnchor: { identity: unknown; offset: number } | null = null;
  private sizes = new Map<unknown, number>();
  // Heights of rendered items for the current frame: the input bar asks for
  // every item's height on each scroll frame.
  private heightSnapshot: {
    average: number;
    heights: Map<unknown, number>;
  } | null = null;
  // Item elements with the data they render, registered by ListItemWrapper.
  private itemByElement = new WeakMap<Element, Data>();
  private rendered: Data[] = [];
  private flushScheduled = false;
  private locationScheduled = false;
  // False once the list unmounts: queued frames must not scroll a page the
  // list no longer owns, such as the window after a conversation switch.
  private attached = true;

  constructor(
    store: MessageListStore<Data, Context>,
    location: LocationSource,
    context: Context
  ) {
    this.store = store;
    this.location = location;
    this.context = context;
    this.methods = {
      data: store.data,
      getScrollLocation: () => this.readLocation(),
      height: (item) => this.height(item),
      scrollToItem: (target) => store.requestScroll(target),
    };
    store.view = {
      beforeStructuralChange: () => this.captureChangeAnchor(),
      keepViewport: () => {
        this.pinnedToBottom = false;
      },
      getContext: () => this.context,
      getScrollLocation: () => this.readLocation(),
      isScrollInProgress: () => this.smoothScroll !== null,
    };
    store.onScrollRequest = () => {
      // Otherwise the next render schedules the flush.
      if (store.getVersion() === this.renderedVersion) {
        this.scheduleFlush();
      }
    };
  }

  private metrics(): ScrollMetrics | null {
    if (this.windowMode) {
      const doc = document.scrollingElement ?? document.documentElement;
      return {
        clientHeight: window.innerHeight,
        scrollHeight: doc.scrollHeight,
        scrollTop: window.scrollY,
        viewportTop: 0,
      };
    }
    const scroller = this.scroller;
    if (!scroller) {
      return null;
    }
    return {
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
      scrollTop: scroller.scrollTop,
      viewportTop: scroller.getBoundingClientRect().top + scroller.clientTop,
    };
  }

  readLocation(): ListScrollLocation {
    const metrics = this.metrics();
    if (!metrics) {
      return DETACHED_LOCATION;
    }
    const distance =
      metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
    // Fractional scroll positions never reach exactly 0.
    const bottomOffset = distance <= 1 ? 0 : Math.round(distance);
    const listTop =
      this.list?.getBoundingClientRect().top ?? metrics.viewportTop;
    return {
      bottomOffset,
      isAtBottom: bottomOffset === 0 || this.smoothScroll?.toBottom === true,
      listOffset: Math.round(listTop - metrics.viewportTop),
      scrollHeight: Math.round(metrics.scrollHeight),
      visibleListHeight: Math.max(
        0,
        metrics.clientHeight - (this.footer?.offsetHeight ?? 0)
      ),
    };
  }

  // Publishes the location to useVirtuosoLocation, and to onScroll for scrolls.
  publishLocation(fromScroll: boolean): void {
    if (!this.attached) {
      return;
    }
    const next = this.readLocation();
    this.location.set(next);
    if (fromScroll && this.initialized) {
      this.onScroll?.(next);
    }
  }

  handleScroll = (): void => {
    if (this.locationScheduled) {
      return;
    }
    this.locationScheduled = true;
    requestAnimationFrame(() => {
      this.locationScheduled = false;
      if (!this.attached) {
        return;
      }
      if (this.smoothScroll === null && this.changeAnchor === null) {
        this.pinnedToBottom = this.readLocation().bottomOffset === 0;
      }
      this.viewAnchor = this.firstVisibleItem();
      this.publishLocation(true);
    });
  };

  // Rendered items or the footer changed size.
  handleResize = (): void => {
    this.heightSnapshot = null;
    if (
      this.pinnedToBottom &&
      this.initialized &&
      this.smoothScroll === null &&
      performance.now() - this.lastUserScrollAtMs > USER_SCROLL_GRACE_MS
    ) {
      this.scrollTop(this.maxScrollTop(), "instant");
    }
    this.publishLocation(false);
  };

  handleUserScrollIntent = (event: Event): void => {
    if (
      isScrollIntent(event, this.windowMode ? null : this.scroller, this.footer)
    ) {
      this.lastUserScrollAtMs = performance.now();
    }
  };

  private scrollTop(top: number, behavior: "instant" | "smooth"): void {
    const target: HTMLElement | Window | null = this.windowMode
      ? window
      : this.scroller;
    if (!target || !this.attached) {
      return;
    }
    if (typeof target.scrollTo === "function") {
      target.scrollTo({ top, behavior });
    } else if (target instanceof HTMLElement) {
      target.scrollTop = top;
    }
  }

  private maxScrollTop(): number {
    const metrics = this.metrics();
    return metrics
      ? Math.max(0, metrics.scrollHeight - metrics.clientHeight)
      : 0;
  }

  scrollToBottom(behavior: NativeScrollBehavior, onSettled?: () => void): void {
    if (behavior === "smooth") {
      this.runSmoothScroll(
        () => this.scrollTop(this.maxScrollTop(), "smooth"),
        true,
        onSettled
      );
      return;
    }
    const token = ++this.scrollToken;
    this.smoothScroll = null;
    this.scrollTop(this.maxScrollTop(), "instant");
    this.pinnedToBottom = true;
    this.settleAtBottom(token, performance.now(), SETTLE_FRAMES, 0, onSettled);
  }

  // Stays at the bottom while rendered items replace size estimates.
  private settleAtBottom(
    token: number,
    startedAtMs: number,
    framesLeft: number,
    stableFrames: number,
    onSettled: (() => void) | undefined
  ): void {
    if (framesLeft === 0 || stableFrames >= 2) {
      onSettled?.();
      return;
    }
    requestAnimationFrame(() => {
      if (token !== this.scrollToken || this.lastUserScrollAtMs > startedAtMs) {
        onSettled?.();
        return;
      }
      const atBottom = this.readLocation().bottomOffset === 0;
      if (!atBottom) {
        this.scrollTop(this.maxScrollTop(), "instant");
      }
      this.settleAtBottom(
        token,
        startedAtMs,
        framesLeft - 1,
        atBottom ? stableFrames + 1 : 0,
        onSettled
      );
    });
  }

  // Runs the smooth scroll that `start` begins and reports it as in progress
  // until the position settles; resizes do not pull it back to the bottom. With
  // `followBottom` it retargets to a growing bottom and ends exactly there,
  // unless the user takes over.
  private runSmoothScroll(
    start: () => void,
    followBottom: boolean,
    onDone?: () => void
  ): void {
    const token = ++this.scrollToken;
    const startedAtMs = performance.now();
    const deadlineMs = startedAtMs + SCROLL_END_TIMEOUT_MS;
    this.smoothScroll = { token, toBottom: followBottom };
    this.pinnedToBottom = false;
    start();
    let target = followBottom ? this.maxScrollTop() : Number.NaN;

    let lastTop = Number.NaN;
    let stableFrames = 0;
    const finish = () => {
      if (this.smoothScroll?.token === token) {
        this.smoothScroll = null;
        this.pinnedToBottom = this.readLocation().bottomOffset === 0;
      }
      this.publishLocation(false);
      onDone?.();
    };
    const check = () => {
      if (token !== this.scrollToken) {
        return;
      }
      const interrupted = this.lastUserScrollAtMs > startedAtMs;
      if (interrupted) {
        finish();
        return;
      }
      if (followBottom) {
        const next = this.maxScrollTop();
        if (Math.abs(next - target) > 1) {
          target = next;
          this.scrollTop(target, "smooth");
          stableFrames = 0;
        }
      }
      const top = this.metrics()?.scrollTop ?? 0;
      stableFrames = top === lastTop ? stableFrames + 1 : 0;
      lastTop = top;
      if (
        stableFrames >= SCROLL_END_STABLE_FRAMES ||
        performance.now() > deadlineMs
      ) {
        if (followBottom && this.readLocation().bottomOffset > 0) {
          this.scrollTop(this.maxScrollTop(), "instant");
        }
        finish();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  // Applies the location a new dataset asked for, then calls `done`.
  positionInitially(
    target: ItemLocationWithAlign | null,
    done: () => void
  ): void {
    if (!target) {
      done();
      return;
    }
    if (this.targetsBottom(target)) {
      this.scrollToBottom("instant", done);
      return;
    }
    this.performScroll({ ...target, behavior: "instant" });
    // react-virtuoso retries until an unrendered item reaches its position.
    requestAnimationFrame(() => requestAnimationFrame(done));
  }

  private targetsBottom(target: ItemLocationWithAlign): boolean {
    const count = this.store.current().length;
    const index = target.index === "LAST" ? count - 1 : target.index;
    return (
      target.align === "end" && index >= count - 1 && (target.offset ?? 0) === 0
    );
  }

  // Scroll position that aligns a rendered item, clamped to the scroll range.
  // Visible space excludes the sticky footer.
  private renderedItemTop(
    index: number,
    align: ListAlign,
    offset: number
  ): number | null {
    const metrics = this.metrics();
    const item = this.store.current()[index];
    const element =
      item === undefined ? null : this.renderedElementOf(this.identity(item));
    if (!metrics || !element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const top = rect.top - metrics.viewportTop + metrics.scrollTop;
    const visible = Math.max(
      0,
      metrics.clientHeight - (this.footer?.offsetHeight ?? 0)
    );
    const aligned = alignedScrollTop(align, top, rect.height, visible);
    return Math.max(0, Math.min(aligned + offset, this.maxScrollTop()));
  }

  private performScroll(target: ItemLocationWithAlign): void {
    const count = this.store.current().length;
    if (count === 0) {
      return;
    }
    const behavior = toNativeBehavior(target.behavior);
    if (this.targetsBottom(target)) {
      this.scrollToBottom(behavior);
      return;
    }
    const index =
      target.index === "LAST"
        ? count - 1
        : Math.max(0, Math.min(target.index, count - 1));
    const align = toListAlign(target.align);
    const offset = target.offset ?? 0;

    const top = this.renderedItemTop(index, align, offset);
    if (top !== null) {
      if (behavior === "smooth") {
        this.runSmoothScroll(() => this.scrollTop(top, "smooth"), false);
      } else {
        this.scrollToken++;
        this.smoothScroll = null;
        this.scrollTop(top, "instant");
        this.pinnedToBottom = this.readLocation().bottomOffset === 0;
      }
      return;
    }
    // Not rendered: let react-virtuoso find it, keeping it clear of the footer.
    const location = {
      index,
      align,
      offset: offset + footerClearance(align, this.footer?.offsetHeight ?? 0),
    };
    if (behavior === "smooth") {
      this.runSmoothScroll(
        () => this.virtuoso?.scrollToIndex({ ...location, behavior: "smooth" }),
        false
      );
    } else {
      this.scrollToken++;
      this.smoothScroll = null;
      this.pinnedToBottom = false;
      this.virtuoso?.scrollToIndex({ ...location, behavior: "auto" });
    }
  }

  scheduleFlush(): void {
    if (this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    // After react-virtuoso renders the data it received during this commit.
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  attach(): void {
    this.attached = true;
  }

  // Invalidates queued scrolls and anchor restores.
  detach(): void {
    this.attached = false;
    this.scrollToken++;
    this.smoothScroll = null;
    this.changeAnchor = null;
  }

  private flush(): void {
    if (!this.attached) {
      return;
    }
    const items = this.store.current();
    if (items.length > 0 && !this.virtuoso) {
      // Not mounted yet; the next render flushes again.
      return;
    }
    // A requested scroll wins over keeping the previous view in place.
    const target = this.store.takePendingScroll();
    if (target) {
      this.changeAnchor = null;
      this.performScroll(target);
    } else if (this.changeAnchor) {
      if (this.pinnedToBottom) {
        // Resizes keep a pinned view at the bottom.
        this.changeAnchor = null;
      } else {
        this.restoreChangeAnchor(ANCHOR_RESTORE_FRAMES, 0);
      }
    }
    this.refreshRendered();
    this.publishLocation(false);
  }

  registerItemElement = (element: Element, item: Data): void => {
    this.itemByElement.set(element, item);
  };

  // Rendered item elements in list order, with the data they show.
  private renderedElements(): { element: HTMLElement; item: Data }[] {
    const rendered: { element: HTMLElement; item: Data }[] = [];
    for (const element of this.list?.querySelectorAll<HTMLElement>(
      "[data-index]"
    ) ?? []) {
      const item = this.itemByElement.get(element);
      if (item !== undefined) {
        rendered.push({ element, item });
      }
    }
    return rendered;
  }

  private renderedElementOf(identity: unknown): HTMLElement | null {
    for (const { element, item } of this.renderedElements()) {
      if (this.identity(item) === identity) {
        return element;
      }
    }
    return null;
  }

  private firstVisibleItem(): { identity: unknown; offset: number } | null {
    const metrics = this.metrics();
    if (!metrics) {
      return null;
    }
    for (const { element, item } of this.renderedElements()) {
      const rect = element.getBoundingClientRect();
      if (rect.bottom > metrics.viewportTop) {
        return {
          identity: this.identity(item),
          offset: rect.top - metrics.viewportTop,
        };
      }
    }
    return null;
  }

  // Where the viewport is now, to restore after the list remounts.
  currentViewLocation(): ItemLocationWithAlign | null {
    if (this.pinnedToBottom) {
      return { index: "LAST", align: "end" };
    }
    const anchor = this.viewAnchor;
    const index = anchor
      ? this.store
          .current()
          .findIndex((item) => this.identity(item) === anchor.identity)
      : -1;
    return anchor && index >= 0
      ? { index, align: "start", offset: -anchor.offset }
      : null;
  }

  // Rows added or removed above the viewport would move it: react-virtuoso
  // compensates a prepend only with estimated sizes, and an insert or delete
  // not at all. This records the first visible item so the change can keep it
  // in place; a view still pinned to the bottom follows the bottom instead.
  // A pending anchor already describes the view before the earlier change.
  private captureChangeAnchor(): void {
    if (this.changeAnchor) {
      return;
    }
    const anchor = this.firstVisibleItem();
    this.changeAnchor = anchor
      ? { ...anchor, capturedAtMs: performance.now() }
      : null;
  }

  private restoreChangeAnchor(framesLeft: number, stableFrames: number): void {
    const anchor = this.changeAnchor;
    if (
      !anchor ||
      framesLeft === 0 ||
      stableFrames >= 3 ||
      this.lastUserScrollAtMs > anchor.capturedAtMs
    ) {
      this.changeAnchor = null;
      return;
    }
    const metrics = this.metrics();
    const element = this.renderedElementOf(anchor.identity);
    let stable = stableFrames + 1;
    if (metrics && element) {
      const delta =
        element.getBoundingClientRect().top -
        metrics.viewportTop -
        anchor.offset;
      if (Math.abs(delta) >= 1) {
        this.scrollTop(metrics.scrollTop + delta, "instant");
        stable = 0;
      }
    }
    requestAnimationFrame(() =>
      this.restoreChangeAnchor(framesLeft - 1, stable)
    );
  }

  handleItemsRendered = (items: ListItem<Data>[]): void => {
    const rendered: Data[] = [];
    for (const item of items) {
      if (item.data !== undefined) {
        this.sizes.set(this.identity(item.data), item.size);
        rendered.push(item.data);
      }
    }
    this.setRendered(rendered);
  };

  // Rendered items whose data changed keep their identity; report the new data.
  private refreshRendered(): void {
    if (this.rendered.length === 0) {
      return;
    }
    const identities = new Set(this.rendered.map(this.identity));
    this.setRendered(
      this.store.current().filter((item) => identities.has(this.identity(item)))
    );
  }

  private setRendered(next: Data[]): void {
    const unchanged =
      next.length === this.rendered.length &&
      next.every((item, index) => item === this.rendered[index]);
    if (unchanged) {
      return;
    }
    this.rendered = next;
    this.onRenderedDataChange?.(next);
  }

  private height(item: Data): number {
    const identity = this.identity(item);
    const snapshot = this.measureRendered();
    return (
      snapshot.heights.get(identity) ??
      this.sizes.get(identity) ??
      snapshot.average
    );
  }

  // Measures every rendered item once per frame.
  private measureRendered(): {
    average: number;
    heights: Map<unknown, number>;
  } {
    if (this.heightSnapshot) {
      return this.heightSnapshot;
    }
    const heights = new Map<unknown, number>();
    for (const { element, item } of this.renderedElements()) {
      const identity = this.identity(item);
      const height = element.getBoundingClientRect().height;
      heights.set(identity, height);
      this.sizes.set(identity, height);
    }
    let total = 0;
    for (const size of this.sizes.values()) {
      total += size;
    }
    const snapshot = {
      average: this.sizes.size === 0 ? 0 : total / this.sizes.size,
      heights,
    };
    this.heightSnapshot = snapshot;
    requestAnimationFrame(() => {
      if (this.heightSnapshot === snapshot) {
        this.heightSnapshot = null;
      }
    });
    return snapshot;
  }

  resetMeasurements(): void {
    this.sizes.clear();
    this.heightSnapshot = null;
    this.rendered = [];
    this.initialized = false;
    this.pinnedToBottom = false;
    this.changeAnchor = null;
    this.viewAnchor = null;
  }

  // Called once the initial location is applied.
  markInitialized(): void {
    this.initialized = true;
    this.pinnedToBottom = this.readLocation().bottomOffset === 0;
    this.viewAnchor = this.firstVisibleItem();
    this.publishLocation(true);
  }
}

interface ListRuntime<Data, Context> {
  location: LocationSource;
  methods: VirtuosoMessageListMethods<Data, Context>;
  registerItemElement: (element: Element, item: Data) => void;
  store: MessageListStore<Data, Context>;
}

// Holds the ListRuntime of the enclosing list. A context cannot carry the
// list's type parameters, so it is typed `unknown` and narrowed by
// `isListRuntime`.
const MessageListRuntimeContext = createContext<unknown>(null);

// Checks the runtime's shape. `Data` and `Context` cannot be checked at
// runtime: they are the types the caller declares for the enclosing list.
function isListRuntime<Data, Context>(
  value: unknown
): value is ListRuntime<Data, Context> {
  return (
    typeof value === "object" &&
    value !== null &&
    "store" in value &&
    value.store instanceof MessageListStore &&
    "location" in value &&
    value.location instanceof LocationSource &&
    "methods" in value &&
    "registerItemElement" in value
  );
}

function useListRuntime<Data, Context>(
  hookName: string
): ListRuntime<Data, Context> {
  const runtime = useContext(MessageListRuntimeContext);
  if (!isListRuntime<Data, Context>(runtime)) {
    throw new Error(`${hookName} must be used inside a VirtuosoMessageList.`);
  }
  return runtime;
}

/**
 * @cc [owner:jchen0824,label:react] stable-methods-reference
 * Within one mounted `VirtuosoMessageList`, `useVirtuosoMethods` MUST return the same object on
 * every render, including after data changes, and so must the list's ref. The caller MUST still
 * re-render when the data changes, so `methods.data.get()` read while rendering is current.
 */
export function useVirtuosoMethods<
  Data,
  Context = unknown,
>(): VirtuosoMessageListMethods<Data, Context> {
  const { store, methods } = useListRuntime<Data, Context>(
    "useVirtuosoMethods"
  );
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return methods;
}

export function useVirtuosoLocation(): ListScrollLocation {
  const { location } = useListRuntime<unknown, unknown>("useVirtuosoLocation");
  return useSyncExternalStore(location.subscribe, location.get, location.get);
}

interface VirtuosoMessageListLicenseProps {
  children: ReactNode;
  // Accepted for compatibility and ignored.
  licenseKey: string;
}

// No license is needed: this list is built on the MIT-licensed react-virtuoso.
export function VirtuosoMessageListLicense({
  children,
}: VirtuosoMessageListLicenseProps) {
  return <>{children}</>;
}

// A formatting context keeps item margins inside the measured item. The
// element is registered with the item it renders, so measurements never rely
// on indexes that may have shifted since the last render.
interface ListItemWrapperProps<Data, Context>
  extends ItemProps<Data>,
    ContextProp<Context> {}

/**
 * @cc [owner:jchen0824,label:react] empty-items-stay-measurable
 * An item whose content renders nothing (hidden onboarding, handover and system messages) MUST
 * still measure at least 1px. react-virtuoso never records a 0px size, and an unmeasured item
 * stops it from rendering the items after it.
 */
function ListItemWrapper<Data, Context>({
  item,
  context: _context,
  style,
  ...props
}: ListItemWrapperProps<Data, Context>) {
  const runtime = useContext(MessageListRuntimeContext);
  const register = useCallback(
    (element: HTMLDivElement | null) => {
      if (element && isListRuntime<Data, Context>(runtime)) {
        runtime.registerItemElement(element, item);
      }
    },
    [runtime, item]
  );
  return (
    <div
      {...props}
      ref={register}
      style={{ ...style, display: "flow-root", minHeight: 1 }}
    />
  );
}

const VIRTUOSO_COMPONENTS = { Item: ListItemWrapper };

interface MessageListComponentProps<Data, Context>
  extends VirtuosoMessageListProps<Data, Context> {
  methodsRef: ForwardedRef<VirtuosoMessageListMethods<Data, Context>>;
}

interface ControllerInputs<Data, Context> {
  context: Context;
  footer: HTMLElement | null;
  itemIdentity: ((item: Data) => unknown) | undefined;
  listRef: RefObject<HTMLDivElement | null>;
  onRenderedDataChange: ((data: Data[]) => void) | undefined;
  onScroll: ((location: ListScrollLocation) => void) | undefined;
  scroller: HTMLElement | null;
  useWindowScroll: boolean;
}

// Keeps the controller in step with the latest props and elements.
function useControllerInputs<Data, Context>(
  controller: ListController<Data, Context>,
  inputs: ControllerInputs<Data, Context>
) {
  useLayoutEffect(() => {
    controller.context = inputs.context;
    controller.identity = inputs.itemIdentity ?? ((item: Data) => item);
    controller.onScroll = inputs.onScroll;
    controller.onRenderedDataChange = inputs.onRenderedDataChange;
    controller.windowMode = inputs.useWindowScroll;
    controller.scroller = inputs.scroller;
    controller.list = inputs.listRef.current;
    controller.footer = inputs.footer;
  });
}

// A new `data.data` array replaces the dataset and applies its scroll modifier.
function useDatasetReset<Data, Context>(
  controller: ListController<Data, Context>,
  store: MessageListStore<Data, Context>,
  data: DataWithScrollModifier<Data> | null | undefined
) {
  const lastSourceRef = useRef<Data[] | null | undefined>(undefined);
  useLayoutEffect(() => {
    const source = data?.data;
    if (source === lastSourceRef.current) {
      return;
    }
    lastSourceRef.current = source;
    const modifier = data?.scrollModifier;
    controller.resetMeasurements();
    store.reset(
      source ?? [],
      modifier?.type === "item-location"
        ? normalizeLocation(modifier.location)
        : null
    );
  }, [controller, data?.data, data?.scrollModifier, store]);
}

// A footer that grows while pinned to the bottom must not cover the last item.
function useFooterResize<Data, Context>(
  controller: ListController<Data, Context>,
  footer: HTMLElement | null
) {
  useLayoutEffect(() => {
    if (!footer || typeof ResizeObserver === "undefined") {
      return;
    }
    let previousHeight = footer.offsetHeight;
    const observer = new ResizeObserver(() => {
      const height = footer.offsetHeight;
      if (height !== previousHeight) {
        previousHeight = height;
        controller.handleResize();
      }
    });
    observer.observe(footer);
    return () => observer.disconnect();
  }, [controller, footer]);
}

// Tracks scrolls, and user intents to scroll, on the scroller or the window.
function useScrollTracking<Data, Context>(
  controller: ListController<Data, Context>,
  scroller: HTMLElement | null,
  useWindowScroll: boolean
) {
  useEffect(() => {
    const target: HTMLElement | Window | null = useWindowScroll
      ? window
      : scroller;
    if (!target) {
      return;
    }
    const { handleScroll, handleUserScrollIntent } = controller;
    const options = { passive: true };
    target.addEventListener("scroll", handleScroll, options);
    target.addEventListener("wheel", handleUserScrollIntent, options);
    target.addEventListener("touchmove", handleUserScrollIntent, options);
    target.addEventListener("keydown", handleUserScrollIntent, options);
    target.addEventListener("pointerdown", handleUserScrollIntent, options);
    return () => {
      target.removeEventListener("scroll", handleScroll);
      target.removeEventListener("wheel", handleUserScrollIntent);
      target.removeEventListener("touchmove", handleUserScrollIntent);
      target.removeEventListener("keydown", handleUserScrollIntent);
      target.removeEventListener("pointerdown", handleUserScrollIntent);
    };
  }, [controller, scroller, useWindowScroll]);
}

// Content and viewport resizes move the location without a scroll event.
function useResizeTracking<Data, Context>(
  controller: ListController<Data, Context>,
  listRef: RefObject<HTMLDivElement | null>,
  scroller: HTMLElement | null,
  useWindowScroll: boolean
) {
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(controller.handleResize);
    observer.observe(list);
    return () => observer.disconnect();
  }, [controller, listRef]);
  useEffect(() => {
    if (useWindowScroll) {
      window.addEventListener("resize", controller.handleResize);
      return () =>
        window.removeEventListener("resize", controller.handleResize);
    }
    if (!scroller || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(controller.handleResize);
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [controller, scroller, useWindowScroll]);
}

// A newly mounted list starts at the top; hide it until it reaches the
// location its data asked for, then start reporting scrolls. Remounting only
// because the scroll mode changed keeps the current view instead.
function useInitialPlacement<Data, Context>(
  controller: ListController<Data, Context>,
  store: MessageListStore<Data, Context>,
  listRef: RefObject<HTMLDivElement | null>,
  mountKey: string | null
) {
  const lastMountRef = useRef<{ generation: number; key: string } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (mountKey === null || !list) {
      return;
    }
    const previous = lastMountRef.current;
    const generation = store.generation;
    lastMountRef.current = { generation, key: mountKey };
    const target =
      previous?.generation === generation
        ? controller.currentViewLocation()
        : store.initialLocation;
    controller.initialized = false;
    list.style.visibility = "hidden";
    let active = true;
    const reveal = () => {
      list.style.visibility = "";
    };
    const frame = requestAnimationFrame(() => {
      controller.positionInitially(target, () => {
        if (!active) {
          return;
        }
        reveal();
        controller.markInitialized();
      });
    });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      reveal();
    };
  }, [controller, listRef, mountKey, store]);
}

// Renders items and computes their keys in the list's own index space.
function useItemRenderers<Data, Context>(
  store: MessageListStore<Data, Context>,
  ItemContent: ComponentType<ItemContentProps<Data, Context>> | undefined,
  computeItemKey: VirtuosoMessageListProps<Data, Context>["computeItemKey"]
) {
  const renderItem = useCallback(
    (absoluteIndex: number, item: Data, itemContext: Context) => {
      if (!ItemContent) {
        return null;
      }
      const all = store.current();
      const index = absoluteIndex - store.firstItemIndex;
      return (
        <ItemContent
          context={itemContext}
          data={item}
          index={index}
          nextData={all[index + 1] ?? null}
          prevData={all[index - 1] ?? null}
        />
      );
    },
    [ItemContent, store]
  );
  const itemKey = useCallback(
    (absoluteIndex: number, item: Data, itemContext: Context): Key =>
      computeItemKey
        ? computeItemKey({
            context: itemContext,
            data: item,
            index: absoluteIndex - store.firstItemIndex,
          })
        : absoluteIndex,
    [computeItemKey, store]
  );
  return { itemKey, renderItem };
}

// With window scrolling, filling the rest of the viewport keeps the footer at
// the bottom of a short list.
function useWindowMinHeight(
  scroller: HTMLElement | null,
  useWindowScroll: boolean,
  enforceStickyFooterAtBottom: boolean
): string | undefined {
  const [minHeight, setMinHeight] = useState<string | undefined>();
  useLayoutEffect(() => {
    if (!useWindowScroll || !enforceStickyFooterAtBottom || !scroller) {
      setMinHeight(undefined);
      return;
    }
    const measure = () => {
      const offset = scroller.getBoundingClientRect().top + window.scrollY;
      setMinHeight(`calc(100dvh - ${Math.max(0, Math.round(offset))}px)`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [enforceStickyFooterAtBottom, scroller, useWindowScroll]);
  return minHeight;
}

function MessageListComponent<Data, Context>({
  computeItemKey,
  context,
  data,
  EmptyPlaceholder,
  enforceStickyFooterAtBottom = false,
  increaseViewportBy = 0,
  ItemContent,
  itemIdentity,
  methodsRef,
  onRenderedDataChange,
  onScroll,
  shortSizeAlign = "top",
  StickyFooter,
  style,
  useWindowScroll = false,
  ...rootProps
}: MessageListComponentProps<Data, Context>) {
  const [store] = useState(() => new MessageListStore<Data, Context>());
  const [controller] = useState(
    () =>
      new ListController<Data, Context>(store, new LocationSource(), context)
  );
  const runtime = useMemo<ListRuntime<Data, Context>>(
    () => ({
      location: controller.location,
      methods: controller.methods,
      registerItemElement: controller.registerItemElement,
      store,
    }),
    [store, controller]
  );
  useImperativeHandle(methodsRef, () => controller.methods, [controller]);
  useLayoutEffect(() => {
    controller.attach();
    return () => controller.detach();
  }, [controller]);

  const version = useSyncExternalStore(
    store.subscribe,
    store.getVersion,
    store.getVersion
  );
  const items = store.current();
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useControllerInputs(controller, {
    context,
    footer,
    itemIdentity,
    listRef,
    onRenderedDataChange,
    onScroll,
    scroller,
    useWindowScroll,
  });
  useDatasetReset(controller, store, data);
  useFooterResize(controller, footer);
  useScrollTracking(controller, scroller, useWindowScroll);
  useResizeTracking(controller, listRef, scroller, useWindowScroll);

  const mountKey =
    items.length > 0 && (useWindowScroll || scroller !== null)
      ? `${store.generation}-${useWindowScroll ? "window" : "element"}`
      : null;
  useInitialPlacement(controller, store, listRef, mountKey);

  // Perform requested scrolls once react-virtuoso has rendered this version.
  useLayoutEffect(() => {
    controller.renderedVersion = version;
    controller.scheduleFlush();
  }, [controller, version]);

  const { itemKey, renderItem } = useItemRenderers(
    store,
    ItemContent,
    computeItemKey
  );
  const setVirtuoso = useCallback(
    (handle: VirtuosoHandle | null) => {
      controller.virtuoso = handle;
    },
    [controller]
  );
  const windowMinHeight = useWindowMinHeight(
    scroller,
    useWindowScroll,
    enforceStickyFooterAtBottom
  );

  const rootStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    ...(useWindowScroll
      ? { minHeight: windowMinHeight }
      : { overflowY: "auto", position: "relative" }),
    ...style,
  };

  return (
    <MessageListRuntimeContext.Provider value={runtime}>
      <div {...rootProps} ref={setScroller} style={rootStyle}>
        <div
          ref={listRef}
          style={{
            flex: "none",
            marginTop: shortSizeAlign === "top" ? undefined : "auto",
          }}
        >
          {items.length === 0 ? (
            EmptyPlaceholder ? (
              <EmptyPlaceholder context={context} />
            ) : null
          ) : mountKey !== null ? (
            <Virtuoso<Data, Context>
              key={mountKey}
              ref={setVirtuoso}
              components={VIRTUOSO_COMPONENTS}
              computeItemKey={itemKey}
              context={context}
              customScrollParent={
                useWindowScroll ? undefined : (scroller ?? undefined)
              }
              data={items}
              firstItemIndex={store.firstItemIndex}
              increaseViewportBy={increaseViewportBy}
              itemContent={renderItem}
              itemsRendered={controller.handleItemsRendered}
              useWindowScroll={useWindowScroll}
            />
          ) : null}
        </div>
        {StickyFooter ? (
          <div
            ref={setFooter}
            style={{
              bottom: 0,
              flex: "none",
              marginTop: enforceStickyFooterAtBottom ? "auto" : undefined,
              position: "sticky",
              zIndex: 1,
            }}
          >
            <StickyFooter context={context} />
          </div>
        ) : null}
      </div>
    </MessageListRuntimeContext.Provider>
  );
}

// Generic forwardRef component, as Sparkle's SearchInputWithPopover.
/**
 * @cc [owner:jchen0824,label:react] pinned-bottom-follows-resizes
 * While the view is at the bottom, resizes of the footer, the viewport or rendered content MUST
 * keep it at the bottom. It stops following once the user scrolls away, or once a data change
 * whose policy requested no scroll keeps the viewport.
 */
export const VirtuosoMessageList = forwardRef<
  VirtuosoMessageListMethods<unknown, unknown>,
  VirtuosoMessageListProps<unknown, unknown>
>(function VirtuosoMessageList(props, ref) {
  return <MessageListComponent {...props} methodsRef={ref} />;
}) as <Data, Context = unknown>(
  props: VirtuosoMessageListProps<Data, Context> & {
    ref?: Ref<VirtuosoMessageListMethods<Data, Context>>;
  }
) => ReactElement | null;
