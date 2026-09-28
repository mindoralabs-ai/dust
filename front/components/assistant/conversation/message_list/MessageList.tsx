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
import type {
  ComponentType,
  CSSProperties,
  ForwardedRef,
  HTMLAttributes,
  Key,
  ReactElement,
  ReactNode,
  Ref,
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
  context?: Context;
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
// Frames spent keeping the first visible item in place after a prepend.
const PREPEND_ANCHOR_FRAMES = 12;
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
  context: Context | undefined = undefined;
  identity: (item: Data) => unknown = (item) => item;
  onScroll: ((location: ListScrollLocation) => void) | undefined;
  onRenderedDataChange: ((data: Data[]) => void) | undefined;
  // onScroll stays silent until the initial position is applied.
  initialized = false;
  renderedVersion = -1;

  // The running programmatic smooth scroll, if any.
  private smoothScroll: { token: number; toBottom: boolean } | null = null;
  private scrollToken = 0;
  private lastUserScrollAt = 0;
  // Whether content resizes keep the viewport at the bottom. Only scrolling
  // (the user's or the list's) changes it.
  private pinnedToBottom = false;
  // The first visible item before a prepend, kept in place once rendered.
  private prependAnchor: {
    capturedAt: number;
    identity: unknown;
    offset: number;
  } | null = null;
  private sizes = new Map<unknown, number>();
  private rendered: Data[] = [];
  private flushScheduled = false;
  private locationScheduled = false;

  constructor(
    store: MessageListStore<Data, Context>,
    location: LocationSource
  ) {
    this.store = store;
    this.location = location;
    this.methods = {
      data: store.data,
      getScrollLocation: () => this.readLocation(),
      height: (item) => this.height(item),
      scrollToItem: (target) => store.requestScroll(target),
    };
    store.view = {
      beforePrepend: () => this.capturePrependAnchor(),
      getContext: () => this.context as Context,
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
      if (this.smoothScroll === null && this.prependAnchor === null) {
        this.pinnedToBottom = this.readLocation().bottomOffset === 0;
      }
      this.publishLocation(true);
    });
  };

  // Rendered items or the footer changed size.
  handleResize = (): void => {
    if (
      this.pinnedToBottom &&
      this.initialized &&
      this.smoothScroll === null &&
      performance.now() - this.lastUserScrollAt > USER_SCROLL_GRACE_MS
    ) {
      this.scrollTop(this.maxScrollTop(), "instant");
    }
    this.publishLocation(false);
  };

  handleUserScrollIntent = (): void => {
    this.lastUserScrollAt = performance.now();
  };

  private scrollTop(top: number, behavior: "instant" | "smooth"): void {
    const target: HTMLElement | Window | null = this.windowMode
      ? window
      : this.scroller;
    if (!target) {
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
      this.smoothScrollTo(true, () => this.maxScrollTop(), onSettled);
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
    startedAt: number,
    framesLeft: number,
    stableFrames: number,
    onSettled: (() => void) | undefined
  ): void {
    if (framesLeft === 0 || stableFrames >= 2) {
      onSettled?.();
      return;
    }
    requestAnimationFrame(() => {
      if (token !== this.scrollToken || this.lastUserScrollAt > startedAt) {
        onSettled?.();
        return;
      }
      const atBottom = this.readLocation().bottomOffset === 0;
      if (!atBottom) {
        this.scrollTop(this.maxScrollTop(), "instant");
      }
      this.settleAtBottom(
        token,
        startedAt,
        framesLeft - 1,
        atBottom ? stableFrames + 1 : 0,
        onSettled
      );
    });
  }

  // Animates to `targetTop()`. A scroll to the bottom follows content that
  // keeps growing, and ends exactly at the bottom unless the user takes over.
  private smoothScrollTo(
    toBottom: boolean,
    targetTop: () => number,
    onDone?: () => void
  ): void {
    const token = ++this.scrollToken;
    const startedAt = performance.now();
    const deadline = startedAt + SCROLL_END_TIMEOUT_MS;
    this.smoothScroll = { token, toBottom };
    let target = targetTop();
    this.scrollTop(target, "smooth");

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
      const interrupted = this.lastUserScrollAt > startedAt;
      if (interrupted) {
        finish();
        return;
      }
      if (toBottom) {
        const next = targetTop();
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
        performance.now() > deadline
      ) {
        if (toBottom && this.readLocation().bottomOffset > 0) {
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
    align: "start" | "center" | "end",
    offset: number
  ): number | null {
    const metrics = this.metrics();
    const element = this.list?.querySelector<HTMLElement>(
      `[data-index="${index}"]`
    );
    if (!metrics || !element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const top = rect.top - metrics.viewportTop + metrics.scrollTop;
    const visible = Math.max(
      0,
      metrics.clientHeight - (this.footer?.offsetHeight ?? 0)
    );
    const aligned =
      align === "start"
        ? top
        : align === "end"
          ? top + rect.height - visible
          : top + rect.height / 2 - visible / 2;
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
    const align =
      target.align === undefined || target.align === "start-no-overflow"
        ? "start"
        : target.align;
    const offset = target.offset ?? 0;

    const top = this.renderedItemTop(index, align, offset);
    if (top !== null) {
      if (behavior === "smooth") {
        this.smoothScrollTo(false, () => top);
      } else {
        this.scrollToken++;
        this.smoothScroll = null;
        this.scrollTop(top, "instant");
        this.pinnedToBottom = this.readLocation().bottomOffset === 0;
      }
      return;
    }
    // Not rendered: let react-virtuoso find it, keeping it clear of the footer.
    const footerHeight = this.footer?.offsetHeight ?? 0;
    this.virtuoso?.scrollToIndex({
      index,
      align,
      behavior: behavior === "smooth" ? "smooth" : "auto",
      offset:
        offset +
        (align === "end"
          ? footerHeight
          : align === "center"
            ? footerHeight / 2
            : 0),
    });
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

  private flush(): void {
    const items = this.store.current();
    if (items.length > 0 && !this.virtuoso) {
      // Not mounted yet; the next render flushes again.
      return;
    }
    const target = this.store.takePendingScroll();
    if (target) {
      this.performScroll(target);
    }
    if (this.prependAnchor) {
      this.restorePrependAnchor(PREPEND_ANCHOR_FRAMES, 0);
    }
    this.refreshRendered();
    this.publishLocation(false);
  }

  private firstVisibleItem(): { identity: unknown; offset: number } | null {
    const metrics = this.metrics();
    if (!metrics || !this.list) {
      return null;
    }
    const items = this.store.current();
    for (const element of this.list.querySelectorAll<HTMLElement>(
      "[data-index]"
    )) {
      const rect = element.getBoundingClientRect();
      const item = items[Number(element.dataset.index)];
      if (item !== undefined && rect.bottom > metrics.viewportTop) {
        return {
          identity: this.identity(item),
          offset: rect.top - metrics.viewportTop,
        };
      }
    }
    return null;
  }

  // react-virtuoso compensates a prepend with estimated item sizes; this keeps
  // the first visible item exactly where it was. The bottom stays pinned instead.
  private capturePrependAnchor(): void {
    if (this.pinnedToBottom) {
      this.prependAnchor = null;
      return;
    }
    const anchor = this.firstVisibleItem();
    this.prependAnchor = anchor
      ? { ...anchor, capturedAt: performance.now() }
      : null;
  }

  private restorePrependAnchor(framesLeft: number, stableFrames: number): void {
    const anchor = this.prependAnchor;
    if (
      !anchor ||
      framesLeft === 0 ||
      stableFrames >= 3 ||
      this.lastUserScrollAt > anchor.capturedAt
    ) {
      this.prependAnchor = null;
      return;
    }
    const metrics = this.metrics();
    const index = this.store
      .current()
      .findIndex((item) => this.identity(item) === anchor.identity);
    const element =
      index >= 0
        ? this.list?.querySelector<HTMLElement>(`[data-index="${index}"]`)
        : null;
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
      this.restorePrependAnchor(framesLeft - 1, stable)
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
    const index = this.store
      .current()
      .findIndex((candidate) => this.identity(candidate) === identity);
    const element =
      index >= 0
        ? this.list?.querySelector<HTMLElement>(`[data-index="${index}"]`)
        : null;
    if (element) {
      const height = element.getBoundingClientRect().height;
      this.sizes.set(identity, height);
      return height;
    }
    const known = this.sizes.get(identity);
    if (known !== undefined) {
      return known;
    }
    if (this.sizes.size === 0) {
      return 0;
    }
    let total = 0;
    for (const size of this.sizes.values()) {
      total += size;
    }
    return total / this.sizes.size;
  }

  resetMeasurements(): void {
    this.sizes.clear();
    this.rendered = [];
    this.initialized = false;
    this.pinnedToBottom = false;
    this.prependAnchor = null;
  }

  // Called once the initial location is applied.
  markInitialized(): void {
    this.initialized = true;
    this.pinnedToBottom = this.readLocation().bottomOffset === 0;
    this.publishLocation(true);
  }
}

interface ListRuntime {
  store: MessageListStore<unknown, unknown>;
  methods: VirtuosoMessageListMethods<unknown, unknown>;
  location: LocationSource;
}

const MessageListRuntimeContext = createContext<ListRuntime | null>(null);

function useListRuntime(hookName: string): ListRuntime {
  const runtime = useContext(MessageListRuntimeContext);
  if (!runtime) {
    throw new Error(`${hookName} must be used inside a VirtuosoMessageList.`);
  }
  return runtime;
}

// The returned object never changes. The caller re-renders when the data
// changes, so reading `methods.data.get()` while rendering stays current.
export function useVirtuosoMethods<
  Data,
  Context = unknown,
>(): VirtuosoMessageListMethods<Data, Context> {
  const { store, methods } = useListRuntime("useVirtuosoMethods");
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  return methods as unknown as VirtuosoMessageListMethods<Data, Context>;
}

export function useVirtuosoLocation(): ListScrollLocation {
  const { location } = useListRuntime("useVirtuosoLocation");
  return useSyncExternalStore(location.subscribe, location.get, location.get);
}

// No license is needed: this list is built on the MIT-licensed react-virtuoso.
export function VirtuosoMessageListLicense({
  children,
}: {
  children: ReactNode;
  licenseKey: string;
}) {
  return <>{children}</>;
}

// A formatting context keeps item margins inside the measured item.
function ListItemWrapper<Data, Context>({
  item: _item,
  context: _context,
  style,
  ...props
}: ItemProps<Data> & ContextProp<Context>) {
  return <div {...props} style={{ ...style, display: "flow-root" }} />;
}

const VIRTUOSO_COMPONENTS = { Item: ListItemWrapper };

type MessageListComponentProps<Data, Context> = VirtuosoMessageListProps<
  Data,
  Context
> & {
  methodsRef: ForwardedRef<VirtuosoMessageListMethods<Data, Context>>;
};

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
    () => new ListController<Data, Context>(store, new LocationSource())
  );
  const runtime = useMemo<ListRuntime>(
    () => ({
      store: store as unknown as MessageListStore<unknown, unknown>,
      methods: controller.methods as unknown as VirtuosoMessageListMethods<
        unknown,
        unknown
      >,
      location: controller.location,
    }),
    [store, controller]
  );
  useImperativeHandle(methodsRef, () => controller.methods, [controller]);

  const version = useSyncExternalStore(
    store.subscribe,
    store.getVersion,
    store.getVersion
  );
  const items = store.current();

  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [footer, setFooter] = useState<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [footerHeight, setFooterHeight] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const [initialLocation, setInitialLocation] =
    useState<ItemLocationWithAlign | null>(null);
  const scrollModifierRef = useRef(data?.scrollModifier);
  scrollModifierRef.current = data?.scrollModifier;

  useLayoutEffect(() => {
    controller.context = context;
    controller.identity = itemIdentity ?? ((item: Data) => item);
    controller.onScroll = onScroll;
    controller.onRenderedDataChange = onRenderedDataChange;
    controller.windowMode = useWindowScroll;
    controller.scroller = scroller;
    controller.list = listRef.current;
    controller.footer = footer;
  });

  // A new `data.data` array replaces the dataset and applies its scroll modifier.
  const sourceData = data?.data;
  const lastSourceRef = useRef<Data[] | null | undefined>(undefined);
  useLayoutEffect(() => {
    if (sourceData === lastSourceRef.current) {
      return;
    }
    lastSourceRef.current = sourceData;
    const modifier = scrollModifierRef.current;
    controller.resetMeasurements();
    store.reset(sourceData ?? []);
    setInitialLocation(
      modifier?.type === "item-location"
        ? normalizeLocation(modifier.location)
        : null
    );
    setGeneration((current) => current + 1);
  }, [controller, sourceData, store]);

  // Measure the footer before mounting the list, so an initial "bottom"
  // location can include it.
  const hasFooter = StickyFooter !== undefined;
  useLayoutEffect(() => {
    if (!footer) {
      if (!hasFooter) {
        setFooterHeight(0);
      }
      return;
    }
    let previousHeight = footer.offsetHeight;
    setFooterHeight(previousHeight);
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(() => {
      const height = footer.offsetHeight;
      if (height === previousHeight) {
        return;
      }
      previousHeight = height;
      setFooterHeight(height);
      // A taller footer must not cover the last item.
      controller.handleResize();
    });
    observer.observe(footer);
    return () => observer.disconnect();
  }, [controller, footer, hasFooter]);

  // Track scrolling on the scroller, or on the window.
  useEffect(() => {
    const target: HTMLElement | Window | null = useWindowScroll
      ? window
      : scroller;
    if (!target) {
      return;
    }
    const intentEvents = ["wheel", "touchmove", "keydown", "pointerdown"];
    target.addEventListener("scroll", controller.handleScroll, {
      passive: true,
    });
    for (const event of intentEvents) {
      target.addEventListener(event, controller.handleUserScrollIntent, {
        passive: true,
      });
    }
    return () => {
      target.removeEventListener("scroll", controller.handleScroll);
      for (const event of intentEvents) {
        target.removeEventListener(event, controller.handleUserScrollIntent);
      }
    };
  }, [controller, scroller, useWindowScroll]);

  // Content resizes move the location without a scroll event.
  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(controller.handleResize);
    observer.observe(list);
    return () => observer.disconnect();
  }, [controller]);

  const mountKey =
    items.length > 0 &&
    footerHeight !== null &&
    (useWindowScroll || scroller !== null)
      ? `${generation}-${useWindowScroll ? "window" : "element"}`
      : null;

  const initialLocationRef = useRef(initialLocation);
  initialLocationRef.current = initialLocation;

  // A newly mounted list starts at the top; hide it until it reaches the
  // location its data asked for, then start reporting scrolls.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (mountKey === null || !list) {
      return;
    }
    controller.initialized = false;
    list.style.visibility = "hidden";
    let active = true;
    const reveal = () => {
      list.style.visibility = "";
    };
    const frame = requestAnimationFrame(() => {
      controller.positionInitially(initialLocationRef.current, () => {
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
  }, [controller, mountKey]);

  // Perform requested scrolls once react-virtuoso has rendered this version.
  useLayoutEffect(() => {
    controller.renderedVersion = version;
    controller.scheduleFlush();
  }, [controller, version]);

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

  const virtuosoComputeItemKey = useCallback(
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

  const setVirtuoso = useCallback(
    (handle: VirtuosoHandle | null) => {
      controller.virtuoso = handle;
    },
    [controller]
  );

  // With window scrolling, filling the rest of the viewport keeps the footer
  // at the bottom of a short list.
  const [windowMinHeight, setWindowMinHeight] = useState<string | undefined>();
  const fillViewport = useWindowScroll && enforceStickyFooterAtBottom;
  useLayoutEffect(() => {
    if (!fillViewport || !scroller) {
      setWindowMinHeight(undefined);
      return;
    }
    const measure = () => {
      const offset = scroller.getBoundingClientRect().top + window.scrollY;
      setWindowMinHeight(`calc(100dvh - ${Math.max(0, Math.round(offset))}px)`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [fillViewport, scroller]);

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
              <EmptyPlaceholder context={context as Context} />
            ) : null
          ) : mountKey !== null ? (
            <Virtuoso<Data, Context>
              key={mountKey}
              ref={setVirtuoso}
              components={VIRTUOSO_COMPONENTS}
              computeItemKey={virtuosoComputeItemKey}
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
            <StickyFooter context={context as Context} />
          </div>
        ) : null}
      </div>
    </MessageListRuntimeContext.Provider>
  );
}

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
