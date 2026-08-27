// The .somni/ per-repo file store — the source of truth (architecture.md §4).
// Plain synchronous fs: call volumes are tiny (dozens of small files).

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'

export type Effort = 'low' | 'medium' | 'high'
export type ReportStyle = 'minimal' | 'compact' | 'full'
export type RunnerName = 'claude' | 'antigravity'
export const RUNNER_NAMES: RunnerName[] = ['claude', 'antigravity']
export type ViewMode = 'po' | 'engineer'
export type Profile = { runner?: RunnerName; model?: string; effort?: Effort }
export type Settings = Profile & {
  concurrency?: number
  timeoutMinutes?: number
  reportStyle?: ReportStyle
  // Empty = look the binary up on PATH (§8).
  claudeBinary?: string
  antigravityBinary?: string
  // Voice input (M12 Decision 1) — empty = look up `whisper-cli` on PATH.
  whisperBinary?: string
  // Nightly Window (M9 Decision 5): the time survives a disarm; armed persists
  // across restarts and is re-armed on app ready.
  nightlyTime?: string // "HH:MM"
  nightlyArmed?: boolean
  // Which sidebar views are shown (M11 Decision 8) — presentation only.
  viewMode?: ViewMode
}

export const SETTINGS_DEFAULTS = {
  concurrency: 2,
  timeoutMinutes: 30,
  reportStyle: 'minimal' as ReportStyle,
  runner: 'claude' as RunnerName,
  viewMode: 'engineer' as ViewMode
}

export type Role = { slug: string; name: string; preamble: string } & Profile
export type Task = { title: string; prompt: string; role: string; selected: boolean }
export type Workflow = {
  slug: string
  name: string
  selected: boolean
  tasks: Task[]
  // The Brief sidecar (workflows/<slug>.brief.md, M8 §4) — absent if never written.
  brief?: string
}

// Work-item store v2 (architecture.md §4.1). One flat store; `kind` is a field,
// so grooming converts an Idea in place.
export type ItemKind = 'idea' | 'epic' | 'story'
export type ItemStatus =
  'backlog' | 'grooming' | 'ready' | 'in-progress' | 'needs-attention' | 'review' | 'done'
export const ITEM_KINDS: ItemKind[] = ['idea', 'epic', 'story']
export const ITEM_STATUSES: ItemStatus[] = [
  'backlog',
  'grooming',
  'ready',
  'in-progress',
  'needs-attention',
  'review',
  'done'
]
export type Item = {
  id: string // SOM-<n>, one sequence across kinds, never reused
  slug: string // the file-name slug, derived from the title
  kind: ItemKind
  status: ItemStatus
  name: string // H1 of the body
  spec: string // the rest of the body — the approved Spec
  created: string
  epic?: string
  blockedBy?: string[] // ids that must be `done` first
  tasks: Task[] // stories only: the .tasks.json sidecar
}

export type RepoData = {
  roles: Role[]
  items: Item[]
  backlog: string[]
  // ponytail: v1 `workflows/` are ignored by the v2 loader (§4.1) — this always
  // empty array only keeps the not-yet-replaced WorkflowsView compiling; it goes
  // with that view in the Board stage.
  workflows: Workflow[]
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled'
  )
}

const dir = (repo: string, ...parts: string[]): string => join(repo, '.somni', ...parts)

// All writes go through here: temp file + rename, state on disk before anything acts on it.
export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, content)
  renameSync(tmp, path)
}

export function ensureSomni(repo: string): void {
  const gi = dir(repo, '.gitignore')
  if (!existsSync(gi)) atomicWrite(gi, 'runs/*/logs/\n')
}

// `---\nkey: value\n---` frontmatter before the H1 — roles carry an execution
// profile (§5), items carry id/kind/status/… (§4.1).
// ponytail: flat `key: value` lines only, hand-parsed — a YAML dependency for
// this is absurd. Lists (`blockedBy`) are comma-separated on one line.
function parseFrontmatter(md: string): { fields: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md)
  if (!m) return { fields: {}, body: md }
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const kv = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (kv) fields[kv[1]] = kv[2]
  }
  return { fields, body: md.slice(m[0].length) }
}

function profileOf(fields: Record<string, string>): Profile {
  const profile: Profile = {}
  if (fields.model) profile.model = fields.model
  if (['low', 'medium', 'high'].includes(fields.effort)) profile.effort = fields.effort as Effort
  if ((RUNNER_NAMES as string[]).includes(fields.runner))
    profile.runner = fields.runner as RunnerName
  return profile
}

// Body → display name (the H1) + the rest.
function splitBody(body: string, fallback: string): { name: string; rest: string } {
  const lines = body.split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  return {
    name: h1 >= 0 ? lines[h1].slice(2).trim() : fallback,
    rest: lines
      .slice(h1 + 1)
      .join('\n')
      .trim()
  }
}

// Execution profile resolution (§5): role → repo config → global settings.
export function resolveProfile(role: Profile | undefined, settings: Settings): Profile {
  return {
    runner: role?.runner ?? settings.runner ?? SETTINGS_DEFAULTS.runner,
    model: role?.model ?? settings.model,
    effort: role?.effort ?? settings.effort
  }
}

// Per-repo overrides layered over the machine-global settings (§4).
export function loadConfig(repo: string): Settings {
  try {
    return JSON.parse(readFileSync(dir(repo, 'config.json'), 'utf8')) as Settings
  } catch {
    return {}
  }
}

export function resolveSettings(
  repo: string,
  global: Settings
): Settings & typeof SETTINGS_DEFAULTS {
  const strip = (s: Settings): Settings =>
    Object.fromEntries(Object.entries(s).filter(([, v]) => v != null && v !== ''))
  return { ...SETTINGS_DEFAULTS, ...strip(global), ...strip(loadConfig(repo)) }
}

function parseRole(slug: string, raw: string): Role {
  const { fields, body } = parseFrontmatter(raw)
  const { name, rest } = splitBody(body, slug)
  return { slug, name, preamble: rest, ...profileOf(fields) }
}

function listFiles(path: string, ext: string): string[] {
  if (!existsSync(path)) return []
  // Sorted: the drain picks the alphabetically-first ticked workflow, so the
  // listing order must not depend on the filesystem.
  return readdirSync(path)
    .filter((f) => f.endsWith(ext))
    .sort()
}

export function loadRepo(repo: string): RepoData {
  const roles = listFiles(dir(repo, 'roles'), '.md').map((f) =>
    parseRole(f.replace(/\.md$/, ''), readFileSync(dir(repo, 'roles', f), 'utf8'))
  )
  // v1 `workflows/` are ignored without error (§4.1) — no migration.
  return { roles, items: loadItems(repo), backlog: loadBacklog(repo), workflows: [] }
}

// ponytail: the v1 workflow reader, kept only for `applyProposal` (chat.ts) —
// the Draft view is hidden in M13 and returns re-aimed at items as Grooming in
// M14, which retires this along with saveWorkflow/deleteWorkflow.
export function loadWorkflows(repo: string): Workflow[] {
  return listFiles(dir(repo, 'workflows'), '.json').flatMap((f) => {
    try {
      const w = JSON.parse(readFileSync(dir(repo, 'workflows', f), 'utf8'))
      const slug = f.replace(/\.json$/, '')
      return [
        {
          slug,
          name: String(w.name ?? f),
          selected: w.selected === true,
          tasks: Array.isArray(w.tasks) ? w.tasks : [],
          brief: loadBrief(repo, slug)
        }
      ]
    } catch {
      return [] // a malformed file shouldn't take the whole repo down
    }
  })
}

// ---- items (architecture.md §4.1) -------------------------------------------

const itemFiles = (repo: string): string[] => listFiles(dir(repo, 'items'), '.md')

const idNum = (id: string): number => Number(/(\d+)/.exec(id)?.[1] ?? 0)

function parseItem(repo: string, file: string): Item {
  const base = file.slice(0, -3)
  const { fields, body } = parseFrontmatter(readFileSync(dir(repo, 'items', file), 'utf8'))
  const named = /^(SOM-\d+)-(.+)$/.exec(base)
  const id = fields.id || named?.[1] || base
  const slug = named?.[2] ?? base
  const { name, rest } = splitBody(body, slug)
  const blockedBy = (fields.blockedBy ?? '').split(/[,\s]+/).filter(Boolean)
  return {
    id,
    slug,
    kind: (ITEM_KINDS as string[]).includes(fields.kind) ? (fields.kind as ItemKind) : 'idea',
    status: (ITEM_STATUSES as string[]).includes(fields.status)
      ? (fields.status as ItemStatus)
      : 'backlog',
    name,
    spec: rest,
    created: fields.created ?? '',
    ...(fields.epic ? { epic: fields.epic } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
    tasks: loadTasks(repo, base)
  }
}

function loadTasks(repo: string, base: string): Task[] {
  try {
    const t = JSON.parse(readFileSync(dir(repo, 'items', base + '.tasks.json'), 'utf8'))
    return Array.isArray(t) ? (t as Task[]) : []
  } catch {
    return []
  }
}

export function loadItems(repo: string): Item[] {
  return itemFiles(repo)
    .flatMap((f) => {
      try {
        return [parseItem(repo, f)]
      } catch {
        return [] // a malformed file shouldn't take the whole repo down
      }
    })
    .sort((a, b) => idNum(a.id) - idNum(b.id)) // ids are unpadded: sort numerically
}

// The id sequence: a bare monotonic integer in .somni/seq. Ids are never reused.
// ponytail: the max over existing files is the belt to seq's braces — a seq file
// lost to a bad merge must not hand out an id that already exists.
export function nextId(repo: string): string {
  const path = dir(repo, 'seq')
  let n = 1
  try {
    n = Math.max(n, parseInt(readFileSync(path, 'utf8').trim(), 10) || 1)
  } catch {
    /* no seq yet */
  }
  for (const f of itemFiles(repo)) {
    const m = /^SOM-(\d+)-/.exec(f)
    if (m) n = Math.max(n, Number(m[1]) + 1)
  }
  atomicWrite(path, `${n + 1}\n`)
  return `SOM-${n}`
}

export function saveItem(repo: string, item: Partial<Item> & { name: string }): Item {
  const id = item.id || nextId(repo)
  const slug = item.slug || slugify(item.name)
  const full: Item = {
    id,
    slug,
    kind: item.kind ?? 'idea',
    status: item.status ?? 'backlog',
    name: item.name,
    spec: (item.spec ?? '').trim(),
    created: item.created || new Date().toISOString(),
    ...(item.epic ? { epic: item.epic } : {}),
    ...(item.blockedBy?.length ? { blockedBy: item.blockedBy } : {}),
    tasks: item.tasks ?? []
  }
  const base = `${id}-${slug}`
  // A retitled item keeps its id and moves file: drop the old basename.
  for (const f of itemFiles(repo)) {
    if (f.startsWith(id + '-') && f !== base + '.md') {
      rmSync(dir(repo, 'items', f), { force: true })
      rmSync(dir(repo, 'items', f.slice(0, -3) + '.tasks.json'), { force: true })
    }
  }
  const fm = [
    `id: ${id}`,
    `kind: ${full.kind}`,
    `status: ${full.status}`,
    `created: ${full.created}`,
    full.epic ? `epic: ${full.epic}` : '',
    full.blockedBy ? `blockedBy: ${full.blockedBy.join(', ')}` : ''
  ].filter(Boolean)
  atomicWrite(
    dir(repo, 'items', base + '.md'),
    `---\n${fm.join('\n')}\n---\n# ${full.name}\n\n${full.spec}\n`
  )
  const tasksPath = dir(repo, 'items', base + '.tasks.json')
  if (full.kind === 'story') atomicWrite(tasksPath, JSON.stringify(full.tasks, null, 2) + '\n')
  else rmSync(tasksPath, { force: true })
  return full
}

export function deleteItem(repo: string, id: string): void {
  for (const f of itemFiles(repo)) {
    if (!f.startsWith(id + '-')) continue
    rmSync(dir(repo, 'items', f), { force: true })
    rmSync(dir(repo, 'items', f.slice(0, -3) + '.tasks.json'), { force: true })
  }
  rmSync(dir(repo, 'chats', id + '.jsonl'), { force: true })
}

// Status is the only field the engine writes, and it re-reads the file first so
// a spec edited meanwhile is never clobbered. Throws if the item is gone.
export function setItemStatus(repo: string, id: string, status: ItemStatus): Item {
  const item = loadItems(repo).find((i) => i.id === id)
  if (!item) throw new Error(`item not found: ${id}`)
  return saveItem(repo, { ...item, status })
}

// The Ready gate (§4.1) — main is the authority for both `item:setStatus` and
// `pipeline:add`. Returns the refusal reason, or null when the item may run.
// The kind check matters because .somni/ is hand-editable: a hand-marked epic
// must not spawn.
export function readyBlocker(item: Item | undefined): string | null {
  if (!item) return 'item not found'
  if (item.kind !== 'story') return `only a Story can be Ready — ${item.id} is an ${item.kind}`
  if (!item.spec.trim()) return `${item.id} has an empty Spec`
  if (!item.tasks.some((t) => t.selected !== false)) return `${item.id} has no selected subtasks`
  return null
}

// Backlog (M9 Decision 4, v2): a bare ordered array of item ids in
// .somni/backlog.json. Ids whose item is gone are pruned in memory; the prune
// lands on disk on the next save.
export function loadBacklog(repo: string): string[] {
  let ids: unknown
  try {
    ids = JSON.parse(readFileSync(dir(repo, 'backlog.json'), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(ids)) return []
  const known = new Set(itemFiles(repo).map((f) => /^(SOM-\d+)-/.exec(f)?.[1] ?? f.slice(0, -3)))
  return ids.filter((s): s is string => typeof s === 'string' && known.has(s))
}

export function saveBacklog(repo: string, ids: string[]): void {
  atomicWrite(dir(repo, 'backlog.json'), JSON.stringify(ids, null, 2) + '\n')
}

export function saveRole(repo: string, role: Role): Role {
  const slug = role.slug || slugify(role.name)
  const fm = [
    role.runner ? `runner: ${role.runner}` : '',
    role.model ? `model: ${role.model}` : '',
    role.effort ? `effort: ${role.effort}` : ''
  ].filter(Boolean)
  const head = fm.length ? `---\n${fm.join('\n')}\n---\n` : ''
  atomicWrite(dir(repo, 'roles', slug + '.md'), `${head}# ${role.name}\n\n${role.preamble}\n`)
  return { ...role, slug }
}

export function deleteRole(repo: string, slug: string): void {
  rmSync(dir(repo, 'roles', slug + '.md'), { force: true })
}

const briefPath = (repo: string, slug: string): string => dir(repo, 'workflows', slug + '.brief.md')

export function loadBrief(repo: string, slug: string): string | undefined {
  const path = briefPath(repo, slug)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

export function saveWorkflow(repo: string, wf: Workflow): Workflow {
  const slug = wf.slug || slugify(wf.name)
  const { name, selected, tasks } = wf
  // ponytail: an absent brief leaves the sidecar alone (a save from the editor
  // carries no brief); only a non-empty brief rewrites it.
  if (wf.brief) atomicWrite(briefPath(repo, slug), wf.brief.trimEnd() + '\n')
  atomicWrite(
    dir(repo, 'workflows', slug + '.json'),
    JSON.stringify({ name, selected, tasks }, null, 2) + '\n'
  )
  return { ...wf, slug }
}

export function deleteWorkflow(repo: string, slug: string): void {
  rmSync(dir(repo, 'workflows', slug + '.json'), { force: true })
  rmSync(briefPath(repo, slug), { force: true })
  // The transcript goes too: a later workflow reusing this slug must not
  // inherit a dead one's history and session id.
  rmSync(dir(repo, 'chats', slug + '.jsonl'), { force: true })
}
