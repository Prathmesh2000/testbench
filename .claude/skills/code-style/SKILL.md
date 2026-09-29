---
name: code-style
description: How code is written in this repo: comments, structure, dependencies, error handling and the AI provider layer. Use before writing or changing any TypeScript here, and when reviewing a diff, or when someone asks "how should this be written", "is this the right pattern", "add a comment", "should I add this dependency", or "where does this logic go". Applies to every package under apps, services, packages and deploy.
---

# How code is written here

## Comments

Comment what the code cannot say itself.

- A one line purpose comment on every non trivial function, type or module. Say what it is for, not what
  it does line by line.
- A why comment wherever a decision is not obvious: a hidden constraint, a workaround, a subtle invariant,
  or a choice a reader would otherwise try to "fix". Example: Postgres is on 5433 because 5432 is usually
  taken by another local project. Without the comment someone changes it back.
- Never restate the line below. `// increment the counter` above `count++` is noise, and noise is why
  people stop reading comments at all.
- Comments are not a changelog. "Changed this to fix the Jira sync" belongs in the commit message. The
  file should read as if it were always written this way.
- Write for the developer who opens the file in a year with no context. They need orientation and reasons.
- Mark a deliberate shortcut with its ceiling and its upgrade path, so it can be found later:

  ```ts
  // ponytail: single global lock, fine under 50 runs/min. Per project locks if throughput matters.
  ```

- Prefer one doc comment on the exported thing over comments scattered inside it.

## Structure

- Match the file you are in. Its naming, its comment density, its idioms. Consistency beats your preference.
- Look before you write. A helper, type or pattern probably already exists in `packages/platform`,
  `packages/contracts` or the sibling service. Reimplementing what lives two files over is the most common
  review finding here.
- No speculative abstraction. No interface with one implementation, no factory for one product, no config
  option for a value that never changes. Add it when the second caller arrives.
- Logic with a rule in it goes in its own file with no database and no Fastify import, so it can have a
  unit test. `services/defect/src/similarity.ts` is the pattern.
- Request and response shapes live in `packages/contracts`. Never redeclare one the API already owns.

## Dependencies

- No new dependency for what a few lines of standard library do. A new one needs a reason in the PR.
- Never read `process.env` outside `packages/platform`. Config is loaded once and passed in.

## Errors and validation

- Validate at trust boundaries and nowhere else. Request bodies are Zod schemas in `packages/contracts`.
  Inside the service the type is already trusted.
- Errors carry context. `AppError` from `@tb/platform` with a code (`notFound()`, `badRequest()`,
  `forbidden()`), not a bare string thrown into the void. Never a 200 with an error inside it.
- Never simplify away input validation, error handling that prevents data loss, permission checks,
  tenant scoping, or accessibility basics.

## AI features

- `AI_MODE` is `mock`, `local` or `cloud`. Mock is the default and what tests use.
- **Validate every model answer with Zod** before it reaches the database or the UI. A model returns text,
  not a type. An unvalidated answer is an unvalidated request body.
- Go through the provider layer in `@tb/ai`. Never call a provider SDK from a feature module.
- Respect the tenant policy and token budget. A call that bypasses them will bill someone.
- Never send secrets, credentials or unmasked evidence to a provider. `maskText` first.
- An AI answer is a draft for a person to accept, not a fact. Say so in the UI.

## Formatting

Prettier and ESLint are the formatter of record: 110 columns, single quotes, trailing commas, and
`import type` for type only imports. Do not hand format, do not argue with them in review.
`pnpm lint` and `pnpm typecheck` pass before a PR opens.
