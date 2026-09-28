import type {
  ListScrollLocation,
  MessageListView,
} from "@app/components/assistant/conversation/message_list/store";
import {
  INITIAL_FIRST_ITEM_INDEX,
  MessageListStore,
} from "@app/components/assistant/conversation/message_list/store";
import { describe, expect, it, vi } from "vitest";

interface Item {
  id: string;
  text?: string;
}

function location(overrides: Partial<ListScrollLocation> = {}) {
  return {
    bottomOffset: 0,
    isAtBottom: true,
    listOffset: 0,
    scrollHeight: 1000,
    visibleListHeight: 500,
    ...overrides,
  };
}

function makeStore(
  items: Item[] = [],
  view: Partial<MessageListView<string>> = {}
) {
  const store = new MessageListStore<Item, string>();
  store.reset(items);
  store.view = {
    beforeStructuralChange: () => {},
    keepViewport: () => {},
    getContext: () => "context",
    getScrollLocation: () => location(),
    isScrollInProgress: () => false,
    ...view,
  };
  return store;
}

const ids = (items: Item[]) => items.map((item) => item.id);

describe("MessageListStore data methods", () => {
  it("applies mutations synchronously and returns copies from get", () => {
    const store = makeStore([{ id: "a" }, { id: "b" }]);

    store.data.append([{ id: "c" }]);
    store.data.insert([{ id: "x" }], 1);
    expect(ids(store.data.get())).toEqual(["a", "x", "b", "c"]);

    const copy = store.data.get();
    copy.pop();
    expect(store.data.get()).toHaveLength(4);
  });

  it("deletes every matching item, so read-back loops terminate", () => {
    const store = makeStore([
      { id: "a" },
      { id: "n1" },
      { id: "b" },
      { id: "n2" },
    ]);

    let passes = 0;
    while (store.data.get().some((item) => item.id.startsWith("n"))) {
      store.data.findAndDelete((item) => item.id.startsWith("n"));
      passes += 1;
    }

    expect(passes).toBe(1);
    expect(ids(store.data.get())).toEqual(["a", "b"]);
  });

  it("maps items and skips a render when nothing changed", () => {
    const store = makeStore([{ id: "a", text: "1" }, { id: "b" }]);
    const listener = vi.fn();
    store.subscribe(listener);

    store.data.map((item) => item);
    expect(listener).not.toHaveBeenCalled();

    store.data.map((item) => (item.id === "a" ? { ...item, text: "2" } : item));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.data.find((item) => item.id === "a")?.text).toBe("2");
    expect(store.data.findIndex((item) => item.id === "b")).toBe(1);
  });

  it("notifies once per batch", () => {
    const store = makeStore([{ id: "a" }]);
    const listener = vi.fn();
    store.subscribe(listener);

    store.data.batch(() => {
      store.data.append([{ id: "b" }]);
      store.data.map((item) => ({ ...item, text: "done" }));
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.data.get()).toEqual([
      { id: "a", text: "done" },
      { id: "b", text: "done" },
    ]);
  });

  it("lowers the first item index by the number of prepended items", () => {
    const store = makeStore([{ id: "c" }]);

    store.data.prepend([{ id: "a" }, { id: "b" }]);

    expect(ids(store.data.get())).toEqual(["a", "b", "c"]);
    expect(store.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX - 2);

    store.reset([{ id: "z" }]);
    expect(store.firstItemIndex).toBe(INITIAL_FIRST_ITEM_INDEX);
  });
});

describe("MessageListStore scroll policies", () => {
  it("scrolls to the bottom for a scalar policy only when already there", () => {
    const atBottom = makeStore([{ id: "a" }]);
    atBottom.data.append([{ id: "b" }], true);
    expect(atBottom.takePendingScroll()).toEqual({
      index: "LAST",
      align: "end",
      behavior: "auto",
    });

    const scrolledUp = makeStore([{ id: "a" }], {
      getScrollLocation: () =>
        location({ bottomOffset: 300, isAtBottom: false }),
    });
    scrolledUp.data.append([{ id: "b" }], "smooth");
    expect(scrolledUp.takePendingScroll()).toBeNull();
  });

  it("gives callbacks the pre-change location and the added data", () => {
    const store = makeStore([{ id: "a" }], {
      getScrollLocation: () =>
        location({ bottomOffset: 120, isAtBottom: false }),
      isScrollInProgress: () => true,
    });
    const policy = vi.fn(() => ({
      index: "LAST" as const,
      align: "end" as const,
      behavior: "smooth" as const,
    }));

    store.data.insert([{ id: "b" }], 1, policy);

    expect(policy).toHaveBeenCalledWith({
      atBottom: false,
      context: "context",
      data: [{ id: "b" }],
      scrollInProgress: true,
      scrollLocation: expect.objectContaining({ bottomOffset: 120 }),
    });
    // A callback scrolls even when the list is not at the bottom.
    expect(store.takePendingScroll()).toEqual({
      index: "LAST",
      align: "end",
      behavior: "smooth",
    });
  });

  it("keeps the viewport when a callback returns false", () => {
    const store = makeStore([{ id: "a" }]);
    store.data.batch(
      () => store.data.map((item) => ({ ...item, text: "x" })),
      () => false
    );
    expect(store.takePendingScroll()).toBeNull();
  });

  it("maps a numeric location to an instant top-aligned scroll", () => {
    const store = makeStore([{ id: "a" }, { id: "b" }]);
    store.requestScroll(1);
    expect(store.takePendingScroll()).toEqual({
      index: 1,
      align: "start",
      behavior: "instant",
    });
  });

  it("requests the scroll after the data change is applied", () => {
    const store = makeStore([{ id: "a" }]);
    const versions: number[] = [];
    store.onScrollRequest = () => versions.push(store.getVersion());
    const before = store.getVersion();

    store.data.append([{ id: "b" }], () => true);

    expect(versions).toEqual([before + 1]);
  });
});

describe("MessageListStore viewport keeping", () => {
  it("keeps the viewport after a data change that requests no scroll", () => {
    const keepViewport = vi.fn();
    const store = makeStore([{ id: "a" }], { keepViewport });

    store.data.append([{ id: "b" }]);
    store.data.insert([{ id: "x" }], 1, false);
    store.data.map((item) => ({ ...item, text: "changed" }));
    expect(keepViewport).toHaveBeenCalledTimes(3);

    // Nothing changed: nothing to keep.
    store.data.map((item) => item);
    expect(keepViewport).toHaveBeenCalledTimes(3);
  });

  it("does not keep the viewport when the change requests a scroll", () => {
    const keepViewport = vi.fn();
    const store = makeStore([{ id: "a" }], { keepViewport });

    store.data.append([{ id: "b" }], true);

    expect(keepViewport).not.toHaveBeenCalled();
    expect(store.takePendingScroll()).not.toBeNull();
  });

  it("lets a batch decide once, from its own policy", () => {
    const keepViewport = vi.fn();
    const store = makeStore([{ id: "a" }], { keepViewport });

    store.data.batch(
      () => store.data.map((item) => ({ ...item, text: "x" })),
      () => ({ index: "LAST" as const, align: "end" as const })
    );
    expect(keepViewport).not.toHaveBeenCalled();
    store.takePendingScroll();

    store.data.batch(
      () => store.data.map((item) => ({ ...item, text: "y" })),
      () => false
    );
    expect(keepViewport).toHaveBeenCalledTimes(1);
  });
});
