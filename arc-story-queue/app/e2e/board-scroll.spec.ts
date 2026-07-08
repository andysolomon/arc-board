import { expect, test } from "@playwright/test";

// Regression coverage for the board's horizontal scroll. The columns row
// (.board-view__columns) holds five fixed-width columns; when they exceed the
// pane width the row must scroll horizontally with its scrollbar reachable.
//
// This has regressed three times: once when the styled scrollbar was dropped;
// again when the liquid-glass reshell moved the board under `.sq-view`, whose
// plain padded block let the row grow to full content height and pushed the
// horizontal scrollbar below the fold; and again in the Tauri desktop shell
// (WKWebView), where the row's default `min-width: auto` let Safari's flexbox
// grow the scroll container past the pane so the overflow escaped to the
// `overflow: hidden` ancestors as a hard clip with no scrollbar. The fixes
// give `.sq-view--board` a full-height flex context and pin
// `.board-view__columns` to `min-width: 0` so it clamps to the pane and scrolls
// internally. These asserts pin those properties: the row overflows and
// actually scrolls, fills the pane height rather than growing past it, and
// keeps `min-width: 0` so the WKWebView clamp holds. The suite runs under both
// Chromium and WebKit (see playwright.config.ts) so the desktop engine is
// represented.

const COLUMNS = ".board-view__columns";

// Narrow viewport so the five ~266px columns overflow horizontally even with
// an empty board (no daemon needed).
test.use({ viewport: { width: 1000, height: 720 } });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(COLUMNS)).toBeVisible();
});

test("board columns row overflows and scrolls horizontally", async ({ page }) => {
  const columns = page.locator(COLUMNS);

  // overflow-x must be a scrolling value, not hidden/visible.
  const overflowX = await columns.evaluate((el) => getComputedStyle(el).overflowX);
  expect(["auto", "scroll"]).toContain(overflowX);

  // As a flex item of the column-direction `.sq-view--board`, the scroll
  // container must keep `min-width: 0`. WKWebView's `min-width: auto` default
  // refuses to shrink the item below its content's min-content width, so the
  // five 266px columns grow it past the pane and the overflow escapes to the
  // `overflow: hidden` ancestors — a hard clip with no scrollbar. Pinning this
  // guards the WKWebView-specific fix regardless of engine.
  const minWidth = await columns.evaluate((el) => getComputedStyle(el).minWidth);
  expect(minWidth).toBe("0px");

  // Content is wider than the visible pane → there is something to scroll.
  const { scrollWidth, clientWidth } = await columns.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }));
  expect(scrollWidth).toBeGreaterThan(clientWidth);

  // Setting scrollLeft actually moves it (proves the overflow is scrollable,
  // not clipped) and it can reach the far edge.
  const maxScroll = scrollWidth - clientWidth;
  const scrolled = await columns.evaluate((el, target) => {
    el.scrollLeft = target;
    return el.scrollLeft;
  }, maxScroll);
  expect(scrolled).toBeGreaterThan(0);
  expect(Math.abs(scrolled - maxScroll)).toBeLessThanOrEqual(2);
});

test("columns row is height-constrained so its scrollbar stays in view", async ({ page }) => {
  const main = page.locator(".sq-main");
  const columns = page.locator(COLUMNS);

  const mainBox = await main.boundingBox();
  const colBox = await columns.boundingBox();
  expect(mainBox).not.toBeNull();
  expect(colBox).not.toBeNull();

  // The row fills the pane rather than collapsing to content height — this is
  // exactly what breaks when the board loses its flex context, letting the
  // horizontal scrollbar fall below the fold.
  expect(colBox!.height).toBeGreaterThan(mainBox!.height * 0.6);

  // And the row's bottom (where the horizontal scrollbar lives) stays within
  // the main pane, so the scrollbar is reachable without vertical scrolling.
  expect(colBox!.y + colBox!.height).toBeLessThanOrEqual(mainBox!.y + mainBox!.height + 1);
});
