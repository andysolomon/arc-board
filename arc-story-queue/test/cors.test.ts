import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { isAllowedOrigin, startDaemon } from "../mcp-server/dist/server.js";

async function getAvailableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function preflight(url: string, origin: string): Promise<Response> {
  return fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type, mcp-protocol-version",
    },
  });
}

describe("daemon CORS loopback policy", () => {
  it("allows any loopback origin and Tauri webview origins", () => {
    expect(isAllowedOrigin("http://localhost:5175")).toBe(true);
    expect(isAllowedOrigin("http://localhost:5173")).toBe(true);
    expect(isAllowedOrigin("https://localhost:65432")).toBe(true);
    expect(isAllowedOrigin("http://127.0.0.1:5175")).toBe(true);
    expect(isAllowedOrigin("http://[::1]:5175")).toBe(true);
    expect(isAllowedOrigin("tauri://localhost")).toBe(true);
    expect(isAllowedOrigin("http://tauri.localhost")).toBe(true);
    expect(isAllowedOrigin("https://tauri.localhost")).toBe(true);
  });

  it("rejects non-loopback origins", () => {
    expect(isAllowedOrigin("http://example.com:5175")).toBe(false);
    expect(isAllowedOrigin("https://192.168.1.10:5175")).toBe(false);
    expect(isAllowedOrigin("https://localhost.example.com:5175")).toBe(false);
  });

  it("echoes requested MCP headers for allowed preflights and omits CORS allow-origin for rejected origins", async () => {
    const port = await getAvailableLoopbackPort();
    const daemon = await startDaemon({ port, host: "127.0.0.1" });

    try {
      const allowed = await preflight(`http://127.0.0.1:${port}/mcp`, "http://localhost:5175");
      expect(allowed.status).toBe(204);
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:5175");
      expect(allowed.headers.get("access-control-allow-headers")).toBe("content-type, mcp-protocol-version");

      const rejected = await preflight(`http://127.0.0.1:${port}/mcp`, "https://example.com");
      expect(rejected.status).toBe(204);
      expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await daemon.close();
    }
  });

  it("accepts preflights on both IPv4 and IPv6 loopback listeners", async () => {
    const port = await getAvailableLoopbackPort();
    const daemon = await startDaemon({ port, host: "127.0.0.1" });

    try {
      const ipv4 = await preflight(`http://127.0.0.1:${port}/mcp`, "http://127.0.0.1:5175");
      expect(ipv4.status).toBe(204);
      expect(ipv4.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5175");

      const ipv6 = await preflight(`http://[::1]:${port}/mcp`, "http://[::1]:5175");
      expect(ipv6.status).toBe(204);
      expect(ipv6.headers.get("access-control-allow-origin")).toBe("http://[::1]:5175");
    } finally {
      await daemon.close();
    }
  });
});
