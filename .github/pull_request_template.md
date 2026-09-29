## What changed

<!-- One or two lines. What a reviewer sees in the diff. -->

## Why

<!-- The problem this solves. Link the issue, the plan section or the Jira key. -->

## How it was tested

<!-- Commands you ran and what you clicked through. "pnpm test" alone is not an answer. -->

- [ ] `pnpm lint`
- [ ] `pnpm typecheck`
- [ ] `pnpm test`
- [ ] Tried it against the local stack

## Screenshots

<!-- Required for any UI change. Before and after if you changed something that existed. -->

## Risk and rollback

<!-- What breaks if this is wrong, and how to undo it. Say "none, additive" if that is true. -->

| Question | Answer |
|---|---|
| New migration | no / `db/migrations/00XX_*.sql` |
| New env var | no / added to `.env.example` |
| Breaking API or contract change | no / yes, and who calls it |
| Rollback | revert the commit / needs a follow up migration |

## Checklist

- [ ] Docs updated in this PR, not a follow up
- [ ] No secrets, tokens or real customer data in the diff
- [ ] Migration is additive and numbered next
- [ ] I read my own diff top to bottom
