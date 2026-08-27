// Vendored Pocock skills (architecture.md §9 M16) injected into target repos.
// The §10 risk — "skills injection touches repos somni doesn't own" — is
// mitigated here and only here: every write is manifest-scoped, CONTEXT.md is
// stubbed only-if-absent, and nothing is ever deleted outside the skill dirs
// the manifest names.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { app, ipcMain } from 'electron'
import { atomicWrite } from './store'

export type SkillsManifest = { version: number; upstream: string; skills: Record<string, string> }
export type SkillsStatus = { bundledVersion: number; repoVersion: number | null }

const MARKER = '.somni-skills.json'

// Skills cannot live in the asar (agents read them off disk), so they ship as
// extraResources: `resources/skills` in dev, `<Resources>/skills` packaged.
export function bundledDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
}

export function loadManifest(): SkillsManifest {
  return JSON.parse(readFileSync(join(bundledDir(), 'manifest.json'), 'utf8')) as SkillsManifest
}

const skillsDir = (repo: string): string => join(repo, '.claude', 'skills')

export function skillsStatus(repo: string): SkillsStatus {
  const bundledVersion = loadManifest().version
  try {
    const marker = JSON.parse(readFileSync(join(skillsDir(repo), MARKER), 'utf8')) as {
      version?: number
    }
    return { bundledVersion, repoVersion: typeof marker.version === 'number' ? marker.version : 0 }
  } catch {
    return { bundledVersion, repoVersion: null }
  }
}

// somni-authored: tells the injected to-spec/to-tickets/implement skills that
// this repo's tracker is .somni/items/, not GitHub issues.
const ISSUE_TRACKER_DOC = `# Issue tracker

<!-- Written by somni. Safe to edit; a skills upgrade overwrites it. -->

This repo's issue tracker is the local directory \`.somni/items/\` — not GitHub
Issues, not Jira. Read and write work items there.

## Layout

- \`.somni/items/SOM-<n>-<slug>.md\` — one work item. The H1 is its title; the
  body below the H1 is the approved Spec.
- \`.somni/items/SOM-<n>-<slug>.tasks.json\` — the story's subtasks:
  \`[{ "title", "prompt", "role", "selected" }]\`.

## Frontmatter

\`\`\`
---
id: SOM-12
kind: idea | epic | story
status: backlog | grooming | ready | in-progress | needs-attention | review | done
created: <ISO 8601>
epic: SOM-3
blockedBy: SOM-10, SOM-11
---
\`\`\`

- Ids are \`SOM-<n>\`, one sequence across all kinds, never reused. The next
  number is in \`.somni/seq\`.
- \`blockedBy\` is a comma-separated list of ids that must be \`done\` before this
  item may run.
- Only a Story with a non-empty Spec and at least one selected subtask may be
  \`ready\`.
`

const CONTEXT_STUB = `# Context

<!-- Stubbed by somni because this repo had no CONTEXT.md. Make it yours. -->

## What this is

_One paragraph: what this codebase does and for whom._

## Vocabulary

_The domain terms this repo uses, and what each one means here._

## Architecture

_The shape of the system: the main modules and the rules about what may depend
on what._
`

// Writes exactly: the manifest-listed skill dirs, the marker, the tracker doc,
// docs/adr/, and CONTEXT.md only if it is absent. Nothing else, ever.
export function injectSkills(repo: string): SkillsStatus {
  const manifest = loadManifest()
  const dest = skillsDir(repo)
  mkdirSync(dest, { recursive: true })
  for (const name of Object.keys(manifest.skills)) {
    const from = join(bundledDir(), name)
    if (!existsSync(from)) continue
    // Scoped to this one dir: an upgrade replaces the skill somni owns and
    // leaves every sibling (including user-authored skills) untouched.
    rmSync(join(dest, name), { recursive: true, force: true })
    cpSync(from, join(dest, name), { recursive: true })
  }
  atomicWrite(join(dest, MARKER), JSON.stringify({ version: manifest.version }, null, 2) + '\n')
  atomicWrite(join(repo, 'docs', 'agents', 'issue-tracker.md'), ISSUE_TRACKER_DOC)
  mkdirSync(join(repo, 'docs', 'adr'), { recursive: true })
  const context = join(repo, 'CONTEXT.md')
  if (!existsSync(context)) atomicWrite(context, CONTEXT_STUB)
  return { bundledVersion: manifest.version, repoVersion: manifest.version }
}

export function wireSkillsIpc(): void {
  ipcMain.handle('skills:status', (_e, repo: string) => skillsStatus(repo))
  ipcMain.handle('skills:inject', (_e, repo: string) => injectSkills(repo))
}
