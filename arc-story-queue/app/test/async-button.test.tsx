/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncButton } from "../src/components/AsyncButton";
import { useAsyncAction } from "../src/lib/useAsyncAction";

function Harness({
  action,
  loadingLabel,
}: {
  action: () => Promise<void>;
  loadingLabel?: string;
}) {
  const { busy, error, run } = useAsyncAction();
  return (
    <>
      <AsyncButton
        busy={busy}
        loadingLabel={loadingLabel}
        onClick={() => run(action)}
        data-testid="async-btn"
      >
        Submit
      </AsyncButton>
      {error && <span data-testid="error">{error}</span>}
    </>
  );
}

describe("useAsyncAction + AsyncButton", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function button(): HTMLButtonElement {
    return container.querySelector("[data-testid='async-btn']") as HTMLButtonElement;
  }

  it("disables the button and shows an inline spinner while the handler is in flight", async () => {
    let resolve!: () => void;
    const action = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );

    await act(async () => {
      root.render(<Harness action={action} loadingLabel="Working…" />);
    });

    await act(async () => {
      button().click();
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(true);
    expect(button().querySelector(".sq-merge-phase__spinner")).not.toBeNull();
    expect(button().textContent).toContain("Working…");

    await act(async () => {
      resolve();
      await Promise.resolve();
    });

    expect(button().disabled).toBe(false);
    expect(button().querySelector(".sq-merge-phase__spinner")).toBeNull();
    expect(button().textContent).toBe("Submit");
  });

  it("ignores repeat clicks until the handler settles", async () => {
    let resolve!: () => void;
    const action = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r;
        }),
    );

    await act(async () => {
      root.render(<Harness action={action} />);
    });

    await act(async () => {
      button().click();
      button().click();
      button().click();
    });

    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve();
      await Promise.resolve();
    });
  });

  it("re-enables the button and removes the spinner after the handler rejects", async () => {
    const action = vi.fn(async () => {
      throw new Error("boom");
    });

    await act(async () => {
      root.render(<Harness action={action} />);
    });

    await act(async () => {
      button().click();
      await Promise.resolve();
    });

    expect(action).toHaveBeenCalledTimes(1);
    expect(button().disabled).toBe(false);
    expect(button().querySelector(".sq-merge-phase__spinner")).toBeNull();
    expect(container.querySelector("[data-testid='error']")?.textContent).toBe("boom");
  });
});
