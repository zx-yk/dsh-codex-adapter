# Known issues / 待确认问题

This file records review findings that are **not confirmed bugs**. Each item
lists what would confirm or dismiss it; delete the item once it has been
checked on a machine with the required environment.

## 1. Windows CLI kill may leave the real CLI process running

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

## 2. TOML array-of-tables is not recognised by the section walker

- File: `src/install/install.mjs` (`tomlTableName`, `removeTomlSection`,
  `codexMcpEnd`)
- Status: unconfirmed — current Codex/Grok configs use plain tables, not
  `[[...]]` arrays under the MCP block
- Why it may matter: `tomlTableName('[[mcp_servers.dsh-adapter.env]]')`
  captures `[mcp_servers.dsh-adapter.env` (leading `[`), so the walker does not
  treat it as a sub-table and leaves it behind when the parent section is
  replaced or removed.
- How to confirm: write a fixture containing
  `[[mcp_servers.dsh-adapter.env]]`, run `upsertCodexMcp` /
  `removeCodexMcp`, and check for an orphan header.
- Possible fix if confirmed: parse `[[...]]` explicitly in `tomlTableName`
  and extend the sub-table check to its captured name.

## 3. A `needs_input` job releases its cwd lock while disposal is still running

- Files: `src/worker-question.mjs`, `src/cwd-lock.mjs`
  (`settledHubLockIds`), `src/hub/index.mjs`
- Status: unconfirmed — disposal is usually quick, but it is started without
  being awaited
- Why it may matter: the question handler sets `job.status = 'needs_input'`
  and calls `Promise.resolve(job.handle?.dispose()).catch(...)` without
  awaiting it. `settledHubLockIds` treats every non-`running` status as
  settled and releases the workspace lock. If disposal is still in flight and
  a tool is writing, a second worker could start in the same cwd.
- How to confirm: use a fake agent whose `dispose()` resolves after a delay,
  raise a question, call `dsh_worker_status` immediately, and observe whether
  the lock is released before disposal completes.

## 4. History loading flag can flip false while another request is pending

- File: `src/client/index.tsx` (`loadHistory`)
- Status: unconfirmed — UI only
- Why it may matter: each request sets `historyLoading = true` and the first
  response's `finally` sets it to false. Two overlapping refreshes can make
  the button look enabled while the newer request is still running. No data
  corruption; the last response still wins.
- How to confirm: trigger two `loadHistory` calls with a delayed first
  response and observe the button state.

## 5. `abbrevPath` does not shorten mixed-separator Windows paths

- File: `src/client/jobs-view.ts` (`abbrevPath`)
- Status: unconfirmed — display only
- Why it may matter: the separator is chosen from `home`; a `home` with `\`
  and a cwd with `/` (or vice versa) will not match, so the path is shown in
  full instead of `~/...`.
- How to confirm: call `abbrevPath('C:/Users/me/repo', 'C:\\Users\\me')`.
- Possible fix if confirmed: normalise both sides before comparing or accept
  both separators.
