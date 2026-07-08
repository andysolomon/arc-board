import { defineConfig, devices } from "@playwright/test";

// E2E config for the board web build. The dev server renders the board shell
// without a daemon (empty columns), which is enough to assert layout/scroll
// behaviour. Point Playwright at Vite and let it manage the server.
// Dedicated port so the e2e run never collides with a dev/tauri server the
// developer may already have on Vite's default 5173. Override with E2E_PORT.
const PORT = Number(process.env.E2E_PORT ?? 5273);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    // Vite binds to `localhost` (IPv6 ::1) by default; 127.0.0.1 is refused.
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // WebKit runs alongside Chromium because the board's horizontal-scroll
  // regressions are WKWebView-specific (the Tauri desktop shell uses Safari's
  // engine). Playwright's WebKit shares Safari's flexbox `min-width: auto`
  // behaviour, so it is the closest representative guard for the desktop clip
  // that Chromium does not reproduce.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
