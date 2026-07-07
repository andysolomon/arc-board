import type { Project } from "arc-contracts";

export interface RegisteredSession {
  id: string;
  repo: string;
  path: string;
  branch: string;
  model: string;
  pid: number;
  projectId?: string;
  status: "connected" | "attached";
}

/** In-memory session registry backing session.register / project.discover / project.attach. */
export class SessionRegistry {
  private sessions = new Map<string, RegisteredSession>();
  private projects = new Map<string, Project>();

  register(input: {
    repo: string;
    path: string;
    branch: string;
    model: string;
    pid: number;
  }): RegisteredSession {
    const id = `sess-${crypto.randomUUID()}`;
    const session: RegisteredSession = {
      id,
      repo: input.repo,
      path: input.path,
      branch: input.branch,
      model: input.model,
      pid: input.pid,
      status: "connected",
    };
    this.sessions.set(id, session);
    return session;
  }

  getSession(sessionId: string): RegisteredSession | undefined {
    return this.sessions.get(sessionId);
  }

  getProject(projectId: string): Project | undefined {
    return this.projects.get(projectId);
  }

  repoOf(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project.repo;
  }

  repoPathOf(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    return project.path;
  }

  discover(): Project[] {
    return [...this.sessions.values()]
      .filter((s) => s.status === "connected")
      .map((s) => ({
        id: s.id,
        repo: s.repo,
        path: s.path,
        branch: s.branch,
        model: s.model,
        pid: s.pid,
        worktreeRoot: "",
        status: "detached" as const,
      }));
  }

  attach(sessionId: string, worktreeRoot: string): Project {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    if (session.status === "attached") {
      const existing = this.projects.get(session.projectId!);
      if (existing) return existing;
    }
    const projectId = `proj-${crypto.randomUUID()}`;
    const project: Project = {
      id: projectId,
      repo: session.repo,
      path: session.path,
      branch: session.branch,
      model: session.model,
      pid: session.pid,
      worktreeRoot,
      status: "attached",
    };
    session.status = "attached";
    session.projectId = projectId;
    this.projects.set(projectId, project);
    return project;
  }

  unregister(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.projectId) this.projects.delete(session.projectId);
    this.sessions.delete(sessionId);
  }
}
