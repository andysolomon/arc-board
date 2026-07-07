import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./components/AppShell";
import { BoardStore } from "./lib/boardStore";
import "./tokens.css";
import "./app.css";

// Use the `localhost` hostname (not the 127.0.0.1 IP literal): a WKWebView (Tauri) is
// stricter about cleartext http to bare IP literals than to the localhost hostname.
const MCP_URL = import.meta.env.VITE_MCP_URL ?? "http://localhost:7420/mcp";

function App() {
  const store = useMemo(() => new BoardStore(MCP_URL), []);
  const [, setTick] = useState(0);

  useEffect(() => {
    return store.subscribe(() => setTick((n) => n + 1));
  }, [store]);

  // Connect to the daemon on load so the pill reflects reality immediately.
  useEffect(() => {
    void store.connect().catch(() => undefined);
  }, [store]);

  useEffect(() => {
    return () => {
      void store.close();
    };
  }, [store]);

  return (
    <div className="app-shell">
      <AppShell store={store} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
