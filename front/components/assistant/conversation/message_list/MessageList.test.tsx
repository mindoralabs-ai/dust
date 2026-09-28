import type {
  ContextAwareProps,
  ItemContentProps,
  VirtuosoMessageListMethods,
} from "@app/components/assistant/conversation/message_list/MessageList";
import {
  useVirtuosoMethods,
  VirtuosoMessageList,
  VirtuosoMessageListLicense,
} from "@app/components/assistant/conversation/message_list/MessageList";
import { act, render, screen } from "@testing-library/react";
import type { Ref } from "react";
import { createRef } from "react";
import { VirtuosoMockContext } from "react-virtuoso";
import { beforeAll, describe, expect, it } from "vitest";

interface Message {
  id: string;
  text: string;
}

beforeAll(() => {
  // jsdom has no layout: react-virtuoso only needs these to exist.
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (typeof HTMLElement.prototype.scrollBy !== "function") {
    HTMLElement.prototype.scrollBy = () => {};
  }
});

function Row({
  context,
  data,
  index,
  nextData,
  prevData,
}: ItemContentProps<Message, string>) {
  const methods = useVirtuosoMethods<Message, string>();
  return (
    <div data-testid={`row-${data.id}`}>
      {`${index}:${data.text}:${prevData?.id ?? "none"}:${nextData?.id ?? "none"}:${context}:${methods.data.get().length}`}
    </div>
  );
}

const seenMethods = new Set<unknown>();

function Footer({ context }: ContextAwareProps<string>) {
  const methods = useVirtuosoMethods<Message, string>();
  seenMethods.add(methods);
  return (
    <div data-testid="footer">{`${context}:${methods.data.get().length}`}</div>
  );
}

function Empty() {
  return <div data-testid="empty">loading</div>;
}

// Fixed sizes: jsdom has no layout.
const MOCK_SIZES = { viewportHeight: 1000, itemHeight: 50 };

function List({
  data,
  methodsRef,
}: {
  data: Message[] | undefined;
  methodsRef?: Ref<VirtuosoMessageListMethods<Message, string>>;
}) {
  return (
    <VirtuosoMockContext.Provider value={MOCK_SIZES}>
      <VirtuosoMessageListLicense licenseKey="">
        <VirtuosoMessageList<Message, string>
          ref={methodsRef}
          context="ctx"
          data={{
            data,
            scrollModifier: {
              type: "item-location",
              location: { index: "LAST", align: "end" },
            },
          }}
          computeItemKey={({ data: message }) => message.id}
          EmptyPlaceholder={Empty}
          ItemContent={Row}
          StickyFooter={Footer}
          style={{ height: 1000 }}
        />
      </VirtuosoMessageListLicense>
    </VirtuosoMockContext.Provider>
  );
}

const messages: Message[] = [
  { id: "a", text: "first" },
  { id: "b", text: "second" },
];

describe("VirtuosoMessageList", () => {
  it("shows the empty placeholder and the footer until data arrives", () => {
    render(<List data={undefined} />);

    expect(screen.getByTestId("empty")).toBeInTheDocument();
    expect(screen.getByTestId("footer")).toHaveTextContent("ctx:0");
  });

  it("renders items with their neighbours and context", async () => {
    render(<List data={messages} />);

    expect(await screen.findByTestId("row-a")).toHaveTextContent(
      "0:first:none:b:ctx:2"
    );
    expect(screen.getByTestId("row-b")).toHaveTextContent(
      "1:second:a:none:ctx:2"
    );
    expect(screen.queryByTestId("empty")).not.toBeInTheDocument();
  });

  it("re-renders hook consumers on data changes with a stable methods object", async () => {
    const methodsRef = createRef<VirtuosoMessageListMethods<Message, string>>();
    seenMethods.clear();
    render(<List data={messages} methodsRef={methodsRef} />);
    await screen.findByTestId("row-a");

    act(() => {
      methodsRef.current?.data.append([{ id: "c", text: "third" }]);
    });

    expect(await screen.findByTestId("row-c")).toHaveTextContent(
      "2:third:b:none:ctx:3"
    );
    expect(screen.getByTestId("footer")).toHaveTextContent("ctx:3");
    expect(seenMethods.size).toBe(1);
    expect(seenMethods.has(methodsRef.current)).toBe(true);
  });

  it("keeps its data across re-renders with the same array, and resets on a new one", async () => {
    const methodsRef = createRef<VirtuosoMessageListMethods<Message, string>>();
    const { rerender } = render(
      <List data={messages} methodsRef={methodsRef} />
    );
    await screen.findByTestId("row-a");

    act(() => {
      methodsRef.current?.data.map((message) => ({
        ...message,
        text: `${message.text}!`,
      }));
    });
    // A new wrapper object around the same array must not reset the list.
    rerender(<List data={messages} methodsRef={methodsRef} />);
    expect(await screen.findByTestId("row-a")).toHaveTextContent("first!");

    rerender(
      <List data={[{ id: "z", text: "other" }]} methodsRef={methodsRef} />
    );
    expect(await screen.findByTestId("row-z")).toBeInTheDocument();
    expect(screen.queryByTestId("row-a")).not.toBeInTheDocument();
    expect(methodsRef.current?.data.get()).toEqual([
      { id: "z", text: "other" },
    ]);
  });

  it("prepends items before the existing ones", async () => {
    const methodsRef = createRef<VirtuosoMessageListMethods<Message, string>>();
    render(<List data={messages} methodsRef={methodsRef} />);
    await screen.findByTestId("row-a");

    act(() => {
      methodsRef.current?.data.prepend([{ id: "older", text: "zero" }]);
    });

    expect(await screen.findByTestId("row-older")).toHaveTextContent(
      "0:zero:none:a:ctx:3"
    );
    expect(screen.getByTestId("row-a")).toHaveTextContent(
      "1:first:older:b:ctx:3"
    );
  });
});
