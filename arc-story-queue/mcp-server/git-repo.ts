import { execFileSync } from "node:child_process";

/**
 * Parse an owner/name slug from a git remote URL. Handles the common forms:
 *   https://github.com/owner/name(.git)
 *   git@github.com:owner/name(.git)          (scp-like)
 *   ssh://git@github.com/owner/name(.git)
 *   github.com/owner/name  or  owner/name
 */
export function parseRepoId(remote: string): string | null {
  let s = remote.trim();
  if (!s) return null;
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");

  const scp = s.match(/^[^/@]+@[^/:]+:(.+)$/); // git@host:owner/name
  if (scp) {
    s = scp[1];
  } else {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ""); // strip proto://
    const parts = s.split("/").filter(Boolean);
    s = parts.length > 2 ? parts.slice(-2).join("/") : parts.join("/");
  }

  return /^[^/\s]+\/[^/\s]+$/.test(s) ? s : null;
}

/** Derive the GitHub owner/name for a local repo path from its origin remote. */
export function deriveRepoId(path: string): { repoId: string | null; remote: string | null } {
  try {
    const remote = execFileSync("git", ["-C", path, "config", "--get", "remote.origin.url"], {
      encoding: "utf8",
    }).trim();
    return { remote: remote || null, repoId: parseRepoId(remote) };
  } catch {
    return { repoId: null, remote: null };
  }
}
