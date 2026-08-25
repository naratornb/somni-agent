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
export type Profile = { model?: string; effort?: Effort }
export type Settings = Profile & {
  concurrency?: number
  timeoutMinutes?: number
  reportStyle?: ReportStyle
}

export const SETTINGS_DEFAULTS = {
  concurrency: 2,
  timeoutMinutes: 30,
  reportStyle: 'minimal' as ReportStyle
}

export type Role = { slug: string; name: string; preamble: string } & Profile
export type Task = { title: string; prompt: string; role: string; selected: boolean }
export type Workflow = { slug: string; name: string; selected: boolean; tasks: Task[] }
export type RepoData = { roles: Role[]; workflows: Workflow[] }

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

// Optional `---\nmodel: x\neffort: high\n---` frontmatter before the H1 (§5).
// ponytail: two known keys, hand-parsed — a YAML dependency for this is absurd.
function parseFrontmatter(md: string): { profile: Profile; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(md)
  if (!m) return { profile: {}, body: md }
  const profile: Profile = {}
  for (const line of m[1].split('\n')) {
    const kv = /^\s*(model|effort)\s*:\s*(.+?)\s*$/.exec(line)
    if (kv?.[1] === 'model') profile.model = kv[2]
    if (kv?.[1] === 'effort' && ['low', 'medium', 'high'].includes(kv[2]))
      profile.effort = kv[2] as Effort
  }
  return { profile, body: md.slice(m[0].length) }
}

// Execution profile resolution (§5): role → repo config → global settings.
export function resolveProfile(role: Profile | undefined, settings: Settings): Profile {
  return { model: role?.model ?? settings.model, effort: role?.effort ?? settings.effort }
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
  const { profile, body: md } = parseFrontmatter(raw)
  const lines = md.split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  const name = h1 >= 0 ? lines[h1].slice(2).trim() : slug
  const preamble = lines
    .slice(h1 + 1)
    .join('\n')
    .trim()
  return { slug, name, preamble, ...profile }
}

function listFiles(path: string, ext: string): string[] {
  if (!existsSync(path)) return []
  return readdirSync(path).filter((f) => f.endsWith(ext))
}

export function loadRepo(repo: string): RepoData {
  const roles = listFiles(dir(repo, 'roles'), '.md').map((f) =>
    parseRole(f.replace(/\.md$/, ''), readFileSync(dir(repo, 'roles', f), 'utf8'))
  )
  const workflows = listFiles(dir(repo, 'workflows'), '.json').flatMap((f) => {
    try {
      const w = JSON.parse(readFileSync(dir(repo, 'workflows', f), 'utf8'))
      return [
        {
          slug: f.replace(/\.json$/, ''),
          name: String(w.name ?? f),
          selected: w.selected === true,
          tasks: Array.isArray(w.tasks) ? w.tasks : []
        }
      ]
    } catch {
      return [] // a malformed file shouldn't take the whole repo down
    }
  })
  return { roles, workflows }
}

export function saveRole(repo: string, role: Role): Role {
  const slug = role.slug || slugify(role.name)
  const fm = [
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

export function saveWorkflow(repo: string, wf: Workflow): Workflow {
  const slug = wf.slug || slugify(wf.name)
  const { name, selected, tasks } = wf
  atomicWrite(
    dir(repo, 'workflows', slug + '.json'),
    JSON.stringify({ name, selected, tasks }, null, 2) + '\n'
  )
  return { ...wf, slug }
}

export function deleteWorkflow(repo: string, slug: string): void {
  rmSync(dir(repo, 'workflows', slug + '.json'), { force: true })
}
