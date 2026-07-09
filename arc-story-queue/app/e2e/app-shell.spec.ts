import { expect, test } from "@playwright/test";

// Regression coverage for the app shell's responsiveness (issue #69). The
// shell (.sq-shell) used to be a fixed 1460×920 card centered in the viewport,
// so a maximized desktop window left large margins and — because the capped
// shell was narrower than the board content — clipped the right-most column
// (Done) with no way to reach it. The shell must instead grow to fill the
// padded viewport so it tracks the window size.
//
// .app-shell keeps a 26px floating-window margin, so the shell fills the
// viewport minus 2×26px on each axis.
const SHELL_PADDING = 26;

test.describe("app shell fills the window (wide viewport)", () => {
  // A viewport far larger than the old 1460×920 cap. If the shell were still
  // capped it would measure ~1460 wide regardless of this viewport.
  const VIEWPORT = { width: 1800, height: 1100 };
  test.use({ viewport: VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".sq-shell")).toBeVisible();
  });

  test("shell grows to fill the padded viewport rather than a fixed 1460×920 card", async ({
    page,
  }) => {
    const box = await page.locator(".sq-shell").boundingBox();
    expect(box).not.toBeNull();

    const expectedWidth = VIEWPORT.width - SHELL_PADDING * 2;
    const expectedHeight = VIEWPORT.height - SHELL_PADDING * 2;

    // Fills the padded viewport (within a couple px for borders/rounding), and
    // crucially is much wider than the old 1460 cap.
    expect(Math.abs(box!.width - expectedWidth)).toBeLessThanOrEqual(2);
    expect(Math.abs(box!.height - expectedHeight)).toBeLessThanOrEqual(2);
    expect(box!.width).toBeGreaterThan(1460);
  });

  test("all columns fit with no horizontal clip at a wide viewport", async ({ page }) => {
    const columns = page.locator(".board-view__columns");
    await expect(columns).toBeVisible();

    // With the shell filling an 1800px-wide window the five 266px columns fit,
    // so the scroll container does not overflow — nothing is clipped.
    const { scrollWidth, clientWidth } = await columns.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);

    // And the scroll container stays within the shell's right edge (no overflow
    // escaping to a clipped ancestor).
    const shellBox = await page.locator(".sq-shell").boundingBox();
    const colBox = await columns.boundingBox();
    expect(shellBox).not.toBeNull();
    expect(colBox).not.toBeNull();
    expect(colBox!.x + colBox!.width).toBeLessThanOrEqual(shellBox!.x + shellBox!.width + 1);
  });
});
