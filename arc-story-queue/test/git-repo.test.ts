import { describe, expect, it } from "vitest";
import { parseRepoId } from "../mcp-server/dist/git-repo.js";

describe("parseRepoId", () => {
  it("parses the common git remote URL forms", () => {
    const expected = "andysolomon/arc-orchestrator";
    expect(parseRepoId("https://github.com/andysolomon/arc-orchestrator.git")).toBe(expected);
    expect(parseRepoId("https://github.com/andysolomon/arc-orchestrator")).toBe(expected);
    expect(parseRepoId("git@github.com:andysolomon/arc-orchestrator.git")).toBe(expected);
    expect(parseRepoId("ssh://git@github.com/andysolomon/arc-orchestrator.git")).toBe(expected);
    expect(parseRepoId("git://github.com/andysolomon/arc-orchestrator.git")).toBe(expected);
    expect(parseRepoId("andysolomon/arc-orchestrator")).toBe(expected);
    expect(parseRepoId("https://github.com/andysolomon/arc-orchestrator.git/")).toBe(expected);
  });

  it("returns null for junk", () => {
    expect(parseRepoId("")).toBeNull();
    expect(parseRepoId("not-a-repo")).toBeNull();
    expect(parseRepoId("https://github.com/")).toBeNull();
  });
});
