import { describe, expect, it } from "vitest";
import {
  ARC_COLUMN_FIELD_NAME,
  ensureGithubBoard,
  findGithubProjectByTitle,
  ownerFromRepo,
  resolveStatusField,
  type GhRunner,
} from "../mcp-server/dist/github-projects.js";
import { QueueManager } from "../mcp-server/dist/queue.js";
import { SessionRegistry } from "../mcp-server/dist/registry.js";
import { SseHub } from "../mcp-server/dist/sse.js";
import { StoryStore } from "../mcp-server/dist/store.js";

function makeQueue(runner?: GhRunner) {
  const store = new StoryStore(":memory:");
  const registry = new SessionRegistry();
  const queue = new QueueManager(
    { worktreeRoot: "/tmp/wt", maxParallel: 2 },
    {
      store,
      registry,
      sse: new SseHub(),
      commandRunner: runner,
    }
  );
  return { store, registry, queue };
}

function mockGh(handlers: Record<string, () => unknown>): GhRunner {
  return (_file, args) => {
    const key = args.join(" ");
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (key.includes(pattern)) {
        const value = handler();
        return typeof value === "string" ? value : JSON.stringify(value);
      }
    }
    throw new Error(`Unexpected gh args: ${key}`);
  };
}

const sampleProject = {
  id: "PVT_test",
  number: 7,
  title: "Arc Board · api",
  url: "https://github.com/users/acme/projects/7",
  owner: { login: "acme", type: "User" },
};

const defaultStatusFields = {
  fields: [
    {
      id: "PVTSSF_status",
      name: "Status",
      type: "ProjectV2SingleSelectField",
      options: [
        { id: "todo", name: "Todo" },
        { id: "ip", name: "In Progress" },
        { id: "done", name: "Done" },
      ],
    },
  ],
};

const arcColumnField = {
  id: "PVTSSF_arc",
  name: ARC_COLUMN_FIELD_NAME,
  type: "ProjectV2SingleSelectField",
  options: [
    { id: "o_backlog", name: "backlog" },
    { id: "o_queued", name: "queued" },
    { id: "o_ip", name: "in_progress" },
    { id: "o_review", name: "review" },
    { id: "o_done", name: "done" },
  ],
};

describe("github-projects ensure (#165)", () => {
  it("parses owner from repo", () => {
    expect(ownerFromRepo("acme/api")).toBe("acme");
  });

  it("finds a project by convention title", () => {
    const runner = mockGh({
      "project list": () => ({ projects: [sampleProject], totalCount: 1 }),
    });
    expect(findGithubProjectByTitle("acme", "Arc Board · api", runner)?.number).toBe(7);
  });

  it("creates Arc Column when Status options do not match board columns", () => {
    const runner = mockGh({
      "field-list": () => defaultStatusFields,
      "field-create": () => arcColumnField,
    });
    const resolved = resolveStatusField("acme", 7, defaultStatusFields.fields, runner);
    expect(resolved.created).toBe(true);
    expect(resolved.field.id).toBe("PVTSSF_arc");
    expect(resolved.statusOptionIds.in_progress).toBe("o_ip");
  });

  it("reuses Status when option names already match columns", () => {
    const fields = [
      {
        id: "PVTSSF_status",
        name: "Status",
        type: "ProjectV2SingleSelectField",
        options: [
          { id: "b", name: "backlog" },
          { id: "q", name: "queued" },
          { id: "i", name: "in_progress" },
          { id: "r", name: "review" },
          { id: "d", name: "done" },
        ],
      },
    ];
    const resolved = resolveStatusField("acme", 7, fields, mockGh({}));
    expect(resolved.created).toBe(false);
    expect(resolved.field.id).toBe("PVTSSF_status");
    expect(resolved.statusOptionIds).toEqual({
      backlog: "b",
      queued: "q",
      in_progress: "i",
      review: "r",
      done: "d",
    });
  });

  it("creates a project when autoCreate is true and none exists", () => {
    let created = false;
    const runner = mockGh({
      "project list": () => ({ projects: [], totalCount: 0 }),
      "project create": () => {
        created = true;
        return sampleProject;
      },
      "field-list": () => defaultStatusFields,
      "field-create": () => arcColumnField,
      "project link": () => "",
    });
    const result = ensureGithubBoard({
      repo: "acme/api",
      autoCreate: true,
      runner,
    });
    expect(created).toBe(true);
    expect(result.createdProject).toBe(true);
    expect(result.binding.githubProjectId).toBe("PVT_test");
    expect(result.binding.statusFieldId).toBe("PVTSSF_arc");
    expect(result.binding.statusOptionIds?.done).toBe("o_done");
  });

  it("refuses to create without autoCreate", () => {
    const runner = mockGh({
      "project list": () => ({ projects: [], totalCount: 0 }),
    });
    expect(() => ensureGithubBoard({ repo: "acme/api", runner })).toThrow(/autoCreate/);
  });

  it("is idempotent when the project and Arc Column already exist", () => {
    const runner = mockGh({
      "project list": () => ({ projects: [sampleProject], totalCount: 1 }),
      "field-list": () => ({ fields: [arcColumnField] }),
      "project link": () => "",
    });
    const first = ensureGithubBoard({ repo: "acme/api", autoCreate: true, runner });
    const second = ensureGithubBoard({ repo: "acme/api", autoCreate: true, runner });
    expect(first.createdProject).toBe(false);
    expect(second.createdField).toBe(false);
    expect(first.binding.githubProjectId).toBe(second.binding.githubProjectId);
  });

  it("persists ensure result through QueueManager", () => {
    const runner = mockGh({
      "project list": () => ({ projects: [sampleProject], totalCount: 1 }),
      "field-list": () => ({ fields: [arcColumnField] }),
      "project link": () => "",
    });
    const { queue } = makeQueue(runner);
    const binding = queue.ensureGithubBoard({ repo: "acme/api", autoCreate: true, skipLink: true });
    expect(queue.getGithubBoardBinding({ repo: "acme/api" })).toMatchObject({
      githubProjectId: "PVT_test",
      githubProjectNumber: 7,
      statusFieldId: "PVTSSF_arc",
      autoCreate: true,
    });
    expect(binding.statusOptionIds?.review).toBe("o_review");
  });
});
