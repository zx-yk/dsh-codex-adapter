# Known issues / 待确认问题

This file records review findings that are **not confirmed bugs**. Each item
lists what would confirm or dismiss it; delete the item once it has been
checked on a machine with the required environment.

## Open

### 1. Windows CLI kill may leave the real CLI process running

- Files: `src/cli-workers.mjs` (`killGroup`, Windows branch)
- Status: unconfirmed — needs Windows with `agy` / `grok` installed
- Why it may matter: the Windows branch calls `child.kill('SIGTERM')`, which
  targets the direct child. If the CLI is a `.cmd` shim or spawns its own
  child process, the real CLI can survive a timeout/cancel. The job is marked
  failed and its cwd lock is released at that point, so the surviving process
  could still be writing while a new worker starts in the same workspace.
- How to confirm: dispatch a long-running `worker=agy` / `worker=grok` task,
  cancel it, then inspect the process tree (`Get-CimInstance Win32_Process |
  Where-Object ParentProcessId -eq <pid>` or `tasklist /T`) and check whether
  descendants are still alive.
- Possible fix if confirmed: terminate the tree with `taskkill /PID <pid> /T
  /F` or a Windows Job Object, instead of only `child.kill`.

## Resolved by simulation (2026-11-23)

These were confirmed with fixtures/stubs in the repository, without needing
the real host software:

- **TOML array-of-tables** — `tomlTableName` now recognises `[[...]]`, so a
  child such as `[[mcp_servers.dsh-adapter.env]]` is removed with its parent.
  Covered by `tests/codex-mcp-table.test.mjs`.
- **History loading race** — `loadHistory` is sequence-guarded; a slow earlier
  response can no longer overwrite a newer one or clear its loading flag.
- **Mixed-separator `abbrevPath`** — home and cwd are compared with normalized
  separators and the suffix keeps the cwd's separator. Covered by
  `tests/jobs-view.test.mjs`.
- **Skipped TOML tests** — `python3` on Windows is often a `.cmd` shim that
  `spawnSync` cannot launch; the tests now use `python` there, so the
  `tomllib` round-trip suite runs instead of being skipped.
- **`needs_input` disposal race** — while `job.disposing` is true, the hub
  view marks it and `settledHubLockIds` keeps the cwd lock; the flag clears
  only after `dispose()` settles. Covered by `tests/worker-question.test.mjs`
  and `tests/cwd-lock-settled.test.mjs`.
