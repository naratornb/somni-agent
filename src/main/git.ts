// The repo's serialized git mutex — shared by the executor and the IPC layer.

import { execFile } from 'child_process'
import { promisify } from 'util'

const git = promisify(execFile)

// ponytail: concurrent `git worktree add` on one repo can race on .git locks —
// serialize the mutating git calls; the task processes themselves run in parallel.
let gitLock: Promise<unknown> = Promise.resolve()
export function lockedGit(args: string[]): Promise<unknown> {
  const p = gitLock.then(() => git('git', args))
  gitLock = p.catch(() => {})
  return p
}
