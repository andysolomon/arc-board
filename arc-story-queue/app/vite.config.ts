import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Bundle arc-contracts from source so dev/build never ship a stale dist
      // artifact (W-000033). Node consumers (mcp-server) still use dist.
      "arc-contracts": fileURLToPath(
        new URL("../packages/arc-contracts/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    // Pin to IPv4 and fail loudly on port conflicts: Tauri's WebView loads
    // devUrl over 127.0.0.1, so an IPv6-only or port-hopped bind renders a
    // blank window.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});
