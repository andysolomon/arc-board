import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeStory,
  parseWidFromTitle,
  widSequence,
  type AppConfig,
  type Handoff,
  type IntakeItem,
  type KnownProject,
  type RunRecord,
  type Story,
} from "arc-contracts";
import { validateRunRecord } from "./validate.js";

export class StoryStore {
  private db: DatabaseSync;

  constructor(
    dbPath: string = ":memory:",
    private defaultMaxParallel: number = 2
  ) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stories (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_order (
        position INTEGER PRIMARY KEY,
        story_id TEXT NOT NULL UNIQUE
      );
      CREATE TABLE IF NOT EXISTS run_records (
        id TEXT PRIMARY KEY,
        story_id TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS intake_items (
        id TEXT PRIMARY KEY,
        position INTEGER NOT NULL UNIQUE,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        story_id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS counters (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS known_projects (
        path TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        model TEXT NOT NULL,
        last_used_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_known_projects_last_used_at ON known_projects(last_used_at DESC);
    `);
    this.reconcileAllStoryWids();
  }

  upsertKnownProject(project: Pick<KnownProject, "repo" | "path" | "branch" | "model">, lastUsedAt = Date.now()): KnownProject {
    this.db
      .prepare(
        `INSERT INTO known_projects (path, repo, branch, model, last_used_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           repo = excluded.repo,
           branch = excluded.branch,
           model = excluded.model,
           last_used_at = excluded.last_used_at`
      )
      .run(project.path, project.repo, project.branch, project.model, lastUsedAt);
    return { ...project, lastUsedAt, exists: existsSync(project.path) };
  }

  listKnownProjects(limit = 20): KnownProject[] {
    const rows = this.db
      .prepare(
        `SELECT repo, path, branch, model, last_used_at AS lastUsedAt
         FROM known_projects
         ORDER BY last_used_at DESC
         LIMIT ?`
      )
      .all(limit) as Array<Pick<KnownProject, "repo" | "path" | "branch" | "model" | "lastUsedAt">>;
    return rows.map((row) => ({ ...row, exists: existsSync(row.path) }));
  }

  forgetKnownProject(path: string): boolean {
    const result = this.db.prepare("DELETE FROM known_projects WHERE path = ?").run(path);
    return result.changes > 0;
  }

  /** Monotonic work-id allocator for deterministically drafted stories. */
  nextWid(): string {
    this.db
      .prepare(
        "INSERT INTO counters (name, value) VALUES ('wid', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1"
      )
      .run();
    const row = this.db.prepare("SELECT value FROM counters WHERE name = 'wid'").get() as {
      value: number;
    };
    return `W-${String(row.value).padStart(6, "0")}`;
  }

  /** Keep the wid counter at or above an explicit title-derived id so future allocations do not collide. */
  ensureWidCounterAtLeast(sequence: number): void {
    if (!Number.isFinite(sequence) || sequence < 1) return;
    const row = this.db.prepare("SELECT value FROM counters WHERE name = 'wid'").get() as
      | { value: number }
      | undefined;
    const current = row?.value ?? 0;
    if (sequence <= current) return;
    this.db
      .prepare(
        "INSERT INTO counters (name, value) VALUES ('wid', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value"
      )
      .run(sequence);
  }

  isWidTaken(wid: string, exceptStoryId?: string): boolean {
    return this.listStoriesRaw().some((story) => story.wid === wid && story.id !== exceptStoryId);
  }

  upsertStory(story: Story): void {
    const normalized = normalizeStory(story);
    this.db
      .prepare("INSERT INTO stories (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(normalized.id, JSON.stringify(normalized));
  }

  getStory(id: string): Story | null {
    const story = this.readStory(id);
    return story ? this.reconcileWidFromTitle(story) : null;
  }

  listStories(): Story[] {
    return this.listStoriesRaw().map((story) => this.reconcileWidFromTitle(story));
  }

  private readStory(id: string): Story | null {
    const row = this.db.prepare("SELECT data FROM stories WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? normalizeStory(JSON.parse(row.data) as Partial<Story>) : null;
  }

  private listStoriesRaw(): Story[] {
    const rows = this.db.prepare("SELECT data FROM stories").all() as Array<{ data: string }>;
    return rows.map((r) => normalizeStory(JSON.parse(r.data) as Partial<Story>));
  }

  private reconcileAllStoryWids(): void {
    for (const story of this.listStoriesRaw()) {
      this.reconcileWidFromTitle(story);
    }
  }

  /** Align stored wid with a title-embedded W- id when the story was imported before that rule existed. */
  private reconcileWidFromTitle(story: Story): Story {
    const fromTitle = parseWidFromTitle(story.title);
    if (!fromTitle || fromTitle === story.wid) return story;
    if (this.isWidTaken(fromTitle, story.id)) return story;

    const repaired = normalizeStory({ ...story, wid: fromTitle });
    this.ensureWidCounterAtLeast(widSequence(fromTitle));
    this.db
      .prepare("INSERT INTO stories (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data")
      .run(repaired.id, JSON.stringify(repaired));
    return repaired;
  }

  enqueue(storyId: string): void {
    const max = this.db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM queue_order").get() as { m: number };
    this.db.prepare("INSERT OR IGNORE INTO queue_order (position, story_id) VALUES (?, ?)").run(max.m + 1, storyId);
  }

  dequeue(storyId: string): void {
    this.db.prepare("DELETE FROM queue_order WHERE story_id = ?").run(storyId);
  }

  deleteStory(id: string): void {
    this.db.prepare("DELETE FROM stories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM queue_order WHERE story_id = ?").run(id);
    this.db.prepare("DELETE FROM handoffs WHERE story_id = ?").run(id);
  }

  queueIds(): string[] {
    const rows = this.db
      .prepare("SELECT story_id FROM queue_order ORDER BY position ASC")
      .all() as Array<{ story_id: string }>;
    return rows.map((r) => r.story_id);
  }

  private parseRunRecord(data: string): RunRecord {
    const record = JSON.parse(data) as RunRecord;
    validateRunRecord(record);
    return record;
  }

  saveRun(record: RunRecord): void {
    validateRunRecord(record);
    this.db
      .prepare("INSERT INTO run_records (id, story_id, data) VALUES (?, ?, ?)")
      .run(record.id, record.storyId, JSON.stringify(record));
  }

  getRunsForStory(storyId: string): RunRecord[] {
    const rows = this.db
      .prepare("SELECT data FROM run_records WHERE story_id = ?")
      .all(storyId) as Array<{ data: string }>;
    return rows.map((r) => this.parseRunRecord(r.data));
  }

  listRuns(): RunRecord[] {
    return this.getRuns();
  }

  getRuns(): RunRecord[] {
    const rows = this.db.prepare("SELECT data FROM run_records").all() as Array<{ data: string }>;
    return rows.map((r) => this.parseRunRecord(r.data));
  }

  /** Atomically replace the queue order so `ids` occupy positions 0..n-1. */
  setQueueOrder(ids: string[]): void {
    this.db.exec("DELETE FROM queue_order");
    const stmt = this.db.prepare("INSERT INTO queue_order (position, story_id) VALUES (?, ?)");
    ids.forEach((id, i) => stmt.run(i, id));
  }

  saveHandoff(storyId: string, handoff: Handoff): void {
    this.db
      .prepare(
        "INSERT INTO handoffs (story_id, data) VALUES (?, ?) ON CONFLICT(story_id) DO UPDATE SET data = excluded.data"
      )
      .run(storyId, JSON.stringify(handoff));
  }

  getHandoff(storyId: string): Handoff | null {
    const row = this.db.prepare("SELECT data FROM handoffs WHERE story_id = ?").get(storyId) as
      | { data: string }
      | undefined;
    return row ? (JSON.parse(row.data) as Handoff) : null;
  }

  deleteHandoff(storyId: string): void {
    this.db.prepare("DELETE FROM handoffs WHERE story_id = ?").run(storyId);
  }

  getConfig(): AppConfig {
    const rows = this.db.prepare("SELECT key, value FROM config").all() as Array<{
      key: string;
      value: string;
    }>;
    const cfg: AppConfig = {
      autoRun: false,
      maxParallel: this.defaultMaxParallel,
      requireOrchestrationPlan: true,
    };
    for (const row of rows) {
      if (row.key === "autoRun") cfg.autoRun = JSON.parse(row.value) as boolean;
      else if (row.key === "maxParallel") cfg.maxParallel = JSON.parse(row.value) as number;
      else if (row.key === "requireOrchestrationPlan") {
        cfg.requireOrchestrationPlan = JSON.parse(row.value) as boolean;
      }
    }
    return cfg;
  }

  /** The persisted maxParallel override, or null when the operator has not set one. */
  getConfiguredMaxParallel(): number | null {
    const row = this.db.prepare("SELECT value FROM config WHERE key = 'maxParallel'").get() as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as number) : null;
  }

  setConfig(patch: Partial<AppConfig>): AppConfig {
    const stmt = this.db.prepare(
      "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    if (patch.autoRun !== undefined) stmt.run("autoRun", JSON.stringify(patch.autoRun));
    if (patch.maxParallel !== undefined) stmt.run("maxParallel", JSON.stringify(patch.maxParallel));
    if (patch.requireOrchestrationPlan !== undefined) {
      stmt.run("requireOrchestrationPlan", JSON.stringify(patch.requireOrchestrationPlan));
    }
    return this.getConfig();
  }

  enqueueIntake(item: IntakeItem): void {
    const max = this.db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM intake_items").get() as { m: number };
    this.db
      .prepare("INSERT INTO intake_items (id, position, data) VALUES (?, ?, ?)")
      .run(item.id, max.m + 1, JSON.stringify(item));
  }

  claimNextIntake(): IntakeItem | null {
    const row = this.db
      .prepare(
        `SELECT id, data FROM intake_items
         WHERE json_extract(data, '$.status') = 'pending'
         ORDER BY position ASC
         LIMIT 1`
      )
      .get() as { id: string; data: string } | undefined;
    if (!row) return null;

    const item = JSON.parse(row.data) as IntakeItem;
    item.status = "claimed";
    this.db.prepare("UPDATE intake_items SET data = ? WHERE id = ?").run(JSON.stringify(item), row.id);
    return item;
  }

  getIntake(id: string): IntakeItem | null {
    const row = this.db.prepare("SELECT data FROM intake_items WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as IntakeItem) : null;
  }

  completeIntake(id: string, storyId: string): void {
    const row = this.db.prepare("SELECT data FROM intake_items WHERE id = ?").get(id) as { data: string } | undefined;
    if (!row) return;

    const item = JSON.parse(row.data) as IntakeItem;
    item.status = "done";
    item.storyId = storyId;
    this.db.prepare("UPDATE intake_items SET data = ? WHERE id = ?").run(JSON.stringify(item), id);
  }

  listIntake(): IntakeItem[] {
    const rows = this.db
      .prepare("SELECT data FROM intake_items ORDER BY position ASC")
      .all() as Array<{ data: string }>;
    return rows.map((r) => JSON.parse(r.data) as IntakeItem);
  }

  close(): void {
    this.db.close();
  }
}
