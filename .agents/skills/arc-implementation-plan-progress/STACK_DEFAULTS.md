# Stack Defaults

Load this only when the user asks for a plan but does not specify the stack.

Default assumptions:

- Next.js + TypeScript + shadcn/ui
- Convex + Clerk + Vercel
- TanStack Query + TanStack Router
- ESNext syntax preference
- zsh-compatible commands
- Jest for Next.js unit/integration tests
- Vitest for Vite projects
- Playwright for end-to-end tests

If the user explicitly chooses SQL:

- Prefer PostgreSQL + Drizzle
- Avoid Prisma by default unless the repo already uses it or the user requests it

Use these as assumptions, not facts. Mark them as defaults in the plan unless repository evidence confirms them.
