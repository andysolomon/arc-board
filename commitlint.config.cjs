// Conventional Commits enforcement (commitlint).
// Repo is ESM ("type":"module"), so this config is CommonJS (.cjs).
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    // Allow the scopes we use across the monorepo; empty scope is also fine.
    "scope-enum": [
      1,
      "always",
      [
        "contracts",
        "mcp-server",
        "daemon",
        "app",
        "tauri",
        "board",
        "queue",
        "release",
        "ci",
        "deps",
        "repo",
      ],
    ],
    "body-max-line-length": [0, "always"],
  },
};
