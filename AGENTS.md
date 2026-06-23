# Project Verification Rules

Use claude-mem and prior session notes only as orientation. For anything that can affect production behavior, always verify the current source of truth before answering or changing code.

Required checks for production-facing changes:

- Search the repo with `rg` for all related defaults, fallbacks, workflow env values, and duplicate implementations.
- Check local config and runtime config separately; `.env` is local only and is not pushed.
- Check GitHub Actions workflows, GitHub secrets/variables, Vercel env, and deployed status when upload, publishing, scheduling, OAuth, or API behavior is involved.
- After editing, verify with the smallest relevant command, then inspect `git diff`.
- When the worktree is mixed, stage and commit only files that belong to the requested change.
- If a change is meant to affect production, push it and confirm the deployment or the next workflow run path.
- Treat old memory, logs, cached UI timestamps, and prior assumptions as stale until verified against current files, env, secrets, or service status.
