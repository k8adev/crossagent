# Contributing

Thanks for considering a contribution to crossagent.

## Dev setup

This project uses [pnpm](https://pnpm.io). The `packageManager` field in
`package.json` pins the exact version; if you have Corepack enabled, it will
be picked up automatically.

```
pnpm install
pnpm dev       # run the CLI directly with tsx, no build step
```

## Running tests

```
pnpm lint      # tsc --noEmit
pnpm test      # vitest run
pnpm build     # tsc -p tsconfig.build.json, emits dist/
```

All three must pass before a PR is merged; CI runs the same three commands
on every push and pull request (see `.github/workflows/ci.yml`).

## Adding a harness

A "harness" is a coding-agent CLI (Claude Code, Codex CLI, …) that crossagent
can detect and drive. Support for a new harness touches two files:

- **`src/harness.ts`** — add the binary name to `KNOWN_HARNESSES`. This is
  matched against a process's `comm` (bare, or as a path's basename) while
  walking up the process tree from `process.ppid`, so use the exact binary
  name as it appears in `ps` output.
- **`src/config.ts`** — add a `harness.<name>` entry to `DEFAULT_CONFIG` with
  an `idleRegex` (matched against a tail window of the pane's last lines to
  decide when the harness is idle) and, optionally, a `busyRegex` (overrides
  `idleRegex` whenever it matches anywhere in the tail window — useful for a
  spinner line) and a `resetCommand` (a slash command or similar that clears
  the harness's conversation state before a `brief`).

These are **best-effort defaults** captured from live panes, expected to be
tuned by hand once you can watch a real session; a user can always override
them per-harness in `~/.config/crossagent/config.toml`. Add tests in
`src/__tests__/harness.test.ts` and `src/__tests__/config.test.ts` covering
detection and the new defaults.

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, …).

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your change, with tests for new behavior.
3. Make sure `pnpm lint`, `pnpm test`, and `pnpm build` all pass.
4. Open a PR describing what changed and why. Link any related issue.

For a new harness, a link to a real session transcript (or a description of
the idle/busy prompt shapes you observed) helps a lot when reviewing the
regexes.
