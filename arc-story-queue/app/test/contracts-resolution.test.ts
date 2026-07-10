import { describe, expect, it } from "vitest";
import * as contracts from "arc-contracts";

// W-000033 regression guard: the app must resolve arc-contracts from source,
// not from a possibly-stale dist build. If the source alias is removed and
// dist falls behind (e.g. after pulling a contracts change without running the
// root build), these exports vanish and this test fails before the board does.
describe("arc-contracts resolution (W-000033)", () => {
  it("exposes the concurrency helpers the board components import", () => {
    expect(typeof contracts.dispatchBlockReason).toBe("function");
    expect(typeof contracts.isDispatchEligible).toBe("function");
    expect(typeof contracts.mutexConflict).toBe("function");
  });
});
