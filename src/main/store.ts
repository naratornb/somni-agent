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

export type Role = { slug: string; name: string; preamble: string }
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

function parseRole(slug: string, md: string): Role {
  const lines = md.split('\n')
  const h1 = lines.findIndex((l) => l.startsWith('# '))
  const name = h1 >= 0 ? lines[h1].slice(2).trim() : slug
  const preamble = lines
    .slice(h1 + 1)
    .join('\n')
    .trim()
  return { slug, name, preamble }
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
  atomicWrite(dir(repo, 'roles', slug + '.md'), `# ${role.name}\n\n${role.preamble}\n`)
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
