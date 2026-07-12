import { expect, test } from "@playwright/test";

// The delegation DAG renders a 1200px canvas. On a narrow viewport the graph
// must scroll inside its own row without pushing horizontal overflow to the page
// (the same containment pattern as board-scroll.spec.ts).

const repoId = "e2e/observability-dag";
const storyId = "story-wide-dag";

const wideDagSeed = {
  activeProjectId: null,
  stories: [
    {
      id: storyId,
      wid: "W-000068",
      type: "story",
      title: "Wide delegation graph",
      repo: repoId,
      branch: "feat/obs-dag",
      worktree: "/wt/obs-dag",
      column: "in_progress",
      priority: "med",
      size: "M",
      epic: "observability",
      taskClass: "feature",
      tags: [],
      description: "Playwright seed for observability DAG scroll containment",
      criteria: ["scroll contained"],
      draft: false,
      lines: [],
      lanes: {},
    },
  ],
  runs: [
    {
      id: "run-plan",
      storyId,
      label: "Plan",
      repo: repoId,
      route: "fable",
      backend: "Claude Code",
      model: "orchestrator",
      access: "parent",
      tokens: 500,
      durMs: 1200,
      startedAt: 100,
      finishedAt: 1300,
      status: "completed",
      changed: 0,
      outcome: "accepted",
    },
    {
      id: "run-explore-a",
      storyId,
      label: "Explore",
      repo: repoId,
      route: "codex-explore",
      backend: "Codex CLI",
      model: "gpt-5.4-mini",
      access: "read-only",
      tokens: 2200,
      durMs: 3400,
      startedAt: 200,
      finishedAt: 3600,
      status: "completed",
      changed: 0,
      outcome: "accepted",
    },
    {
      id: "run-explore-b",
      storyId,
      label: "Deep explore",
      repo: repoId,
      route: "opus-explore",
      backend: "Claude Agent",
      model: "opus-4.8",
      access: "read-only",
      tokens: 4100,
      durMs: 5200,
      startedAt: 250,
      finishedAt: 5450,
      status: "completed",
      changed: 0,
      outcome: "accepted",
    },
    {
      id: "run-build-a",
      storyId,
      label: "Implement",
      repo: repoId,
      route: "composer-implement",
      backend: "Cursor Agent",
      model: "composer-2.5",
      access: "write",
      tokens: 4800,
      durMs: 9200,
      startedAt: 300,
      finishedAt: 9500,
      status: "completed",
      changed: 4,
      outcome: "accepted",
    },
    {
      id: "run-build-b",
      storyId,
      label: "Escalate",
      repo: repoId,
      route: "codex-implement",
      backend: "Codex CLI",
      model: "gpt-5.5",
      access: "write",
      tokens: 6100,
      durMs: 11000,
      startedAt: 350,
      finishedAt: 11350,
      status: "completed",
      changed: 2,
      outcome: "accepted",
    },
    {
      id: "run-check",
      storyId,
      label: "Check",
      repo: repoId,
      route: "codex-check",
      backend: "Codex CLI",
      model: "gpt-5.5",
      access: "read-only",
      tokens: 1800,
      durMs: 4100,
      startedAt: 400,
      finishedAt: 4500,
      status: "completed",
      changed: 0,
      outcome: "accepted",
    },
    {
      id: "run-review",
      storyId,
      label: "Review",
      repo: repoId,
      route: "opus-check",
      backend: "Claude Agent",
      model: "opus-4.8",
      access: "read-only",
      tokens: 2400,
      durMs: 5000,
      startedAt: 450,
      status: "completed",
      changed: 0,
      outcome: "unrated",
    },
    {
      id: "run-decide",
      storyId,
      label: "Decide",
      repo: repoId,
      route: "fable",
      backend: "Claude Code",
      model: "orchestrator",
      access: "parent",
      tokens: 900,
      durMs: 800,
      startedAt: 500,
      status: "completed",
      changed: 0,
      outcome: "unrated",
    },
  ],
};

test.use({ viewport: { width: 720, height: 800 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(
    () => Boolean((window as Window & { __sqStore?: unknown }).__sqStore),
  );
  await page.evaluate((seedJson) => {
    const store = (window as Window & { __sqStore?: { e2eHydrate: (data: unknown) => void } })
      .__sqStore;
    if (!store) throw new Error("Dev store hook missing — is Vite running in development mode?");
    store.e2eHydrate(JSON.parse(seedJson));
  }, JSON.stringify(wideDagSeed));
  await page.getByRole("button", { name: "Observability" }).click();
  await expect(page.locator("[data-testid='obs-delegation-dag']")).toBeVisible();
  await expect(page.locator("[data-testid='obs-dag-scroll']")).toBeVisible();
});

test("wide delegation graph scrolls internally without page overflow", async ({ page }) => {
  const pageOverflow = await page.evaluate(() => ({
    docScroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(pageOverflow.docScroll).toBeLessThanOrEqual(pageOverflow.inner + 1);

  const scroll = page.locator("[data-testid='obs-dag-scroll']");
  await expect(scroll).toBeVisible();

  const overflowX = await scroll.evaluate((el) => getComputedStyle(el).overflowX);
  expect(["auto", "scroll"]).toContain(overflowX);

  const minWidth = await scroll.evaluate((el) => getComputedStyle(el).minWidth);
  expect(minWidth).toBe("0px");

  const { scrollWidth, clientWidth } = await scroll.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeGreaterThan(clientWidth);

  const maxScroll = scrollWidth - clientWidth;
  const scrolled = await scroll.evaluate((el, target) => {
    el.scrollLeft = target;
    return el.scrollLeft;
  }, maxScroll);
  expect(scrolled).toBeGreaterThan(0);
  expect(Math.abs(scrolled - maxScroll)).toBeLessThanOrEqual(2);
});
