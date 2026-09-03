import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  slugify,
  DEFAULT_ROLES,
  ensureSomni,
  loadBacklog,
  loadRepo,
  saveBacklog,
  saveRole,
  deleteRole,
  saveItem,
  deleteItem,
  loadItems,
  nextId,
  readyBlocker,
  resolveProfile,
  resolveSettings,
  setItemStatus,
  archiveStaleSessions,
  reopenSession
} from './store'

let repo: string
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'somni-store-'))
})

describe('slugify', () => {
  it('normalizes names', () => {
    expect(slugify('Senior Developer!')).toBe('senior-developer')
    expect(slugify('  ')).toBe('untitled')
  })
})

describe('store round-trips', () => {
  it('bootstraps .somni/.gitignore once', () => {
    ensureSomni(repo)
    expect(readFileSync(join(repo, '.somni/.gitignore'), 'utf8')).toContain('runs/*/logs/')
  })

  it('seeds the seven default SDLC roles into a fresh repo', () => {
    ensureSomni(repo)
    const roles = loadRepo(repo).roles
    expect(roles.map((r) => r.slug).sort()).toEqual(
      ['architect', 'developer', 'devops', 'reviewer', 'security', 'tech-writer', 'tester'].sort()
    )
    expect(roles).toHaveLength(DEFAULT_ROLES.length)
    for (const role of roles) expect(role.preamble.length, role.slug).toBeGreaterThan(100)
    // Only developer pins a runner (agy can't read .claude/skills/); the rest inherit.
    expect(roles.find((r) => r.slug === 'developer')?.runner).toBe('claude')
    expect(roles.filter((r) => r.runner).map((r) => r.slug)).toEqual(['developer'])
    expect(roles.some((r) => r.model || r.effort)).toBe(false)
  })

  it('never resurrects deleted or edited default roles', () => {
    ensureSomni(repo)
    deleteRole(repo, 'tester')
    const edited = saveRole(repo, { slug: 'devops', name: 'DevOps Engineer', preamble: 'Mine.' })
    ensureSomni(repo) // repo re-opened
    const roles = loadRepo(repo).roles
    expect(roles.some((r) => r.slug === 'tester')).toBe(false)
    expect(roles.find((r) => r.slug === 'devops')).toEqual(edited)
  })

  it('leaves a repo that already has a roles dir untouched', () => {
    const mine = saveRole(repo, { slug: '', name: 'Mine', preamble: 'p' })
    ensureSomni(repo)
    expect(loadRepo(repo).roles).toEqual([mine])
  })

  it('saves and reloads roles and items', () => {
    const role = saveRole(repo, { slug: '', name: 'Senior Tester', preamble: 'You test things.' })
    expect(role.slug).toBe('senior-tester')
    const item = saveItem(repo, {
      name: 'Add feature',
      kind: 'story',
      status: 'ready',
      spec: 'Ship the thing.',
      tasks: [{ title: 'Design', prompt: 'Design it', role: 'senior-tester', selected: true }]
    })
    expect(item.id).toBe('SOM-1')
    expect(existsSync(join(repo, '.somni/items/SOM-1-add-feature.md'))).toBe(true)
    const data = loadRepo(repo)
    expect(data.roles).toEqual([role])
    expect(data.items).toEqual([item])
  })

  it('deletes files', () => {
    saveRole(repo, { slug: '', name: 'X', preamble: 'p' })
    deleteRole(repo, 'x')
    const y = saveItem(repo, { name: 'Y', kind: 'story', tasks: [] })
    deleteItem(repo, y.id)
    expect(loadRepo(repo)).toEqual({ roles: [], items: [], backlog: [] })
    expect(existsSync(join(repo, '.somni/roles/x.md'))).toBe(false)
  })

  it('ignores v1 workflows/ and survives a malformed item', () => {
    mkdirSync(join(repo, '.somni/workflows'), { recursive: true })
    writeFileSync(join(repo, '.somni/workflows/hand.json'), '{"name":"Hand","tasks":[]}')
    mkdirSync(join(repo, '.somni/items'), { recursive: true })
    // a directory where a file should be: the read throws, the rest still loads
    mkdirSync(join(repo, '.somni/items/SOM-9-broken.md'))
    saveItem(repo, { name: 'Fine', kind: 'idea' })
    // the v1 file is simply never read; a broken item doesn't take the rest down
    expect(loadRepo(repo).items.map((i) => i.name)).toEqual(['Fine'])
  })
})

describe('items', () => {
  const story = (name: string, extra = {}): ReturnType<typeof saveItem> =>
    saveItem(repo, {
      name,
      kind: 'story',
      status: 'ready',
      spec: 'the spec',
      tasks: [{ title: 'T', prompt: 'p', role: 'dev', selected: true }],
      ...extra
    })

  it('round-trips every frontmatter field including blockedBy', () => {
    const a = story('First')
    const b = story('Second', { epic: 'SOM-9', blockedBy: [a.id, 'SOM-9'] })
    const raw = readFileSync(join(repo, '.somni/items', `${b.id}-second.md`), 'utf8')
    expect(raw).toContain(`blockedBy: ${a.id}, SOM-9`)
    expect(loadItems(repo)).toEqual([a, b])
    expect(loadItems(repo)[1].blockedBy).toEqual([a.id, 'SOM-9'])
  })

  it('reads hand-written frontmatter and defaults the unknown', () => {
    mkdirSync(join(repo, '.somni/items'), { recursive: true })
    writeFileSync(
      join(repo, '.somni/items/SOM-4-hand.md'),
      '---\nid: SOM-4\nkind: saga\nstatus: nowhere\n---\n# Hand written\n\nSpec text.\n'
    )
    expect(loadItems(repo)[0]).toMatchObject({
      id: 'SOM-4',
      slug: 'hand',
      kind: 'idea', // unknown kind falls back
      status: 'backlog', // unknown status falls back
      name: 'Hand written',
      spec: 'Spec text.',
      tasks: []
    })
  })

  it('sorts numerically, not alphabetically', () => {
    for (let i = 0; i < 11; i++) story(`S${i}`)
    expect(loadItems(repo).map((i) => i.id)).toEqual(
      Array.from({ length: 11 }, (_, i) => `SOM-${i + 1}`)
    )
  })

  it('hands out monotonic ids and never reuses one', () => {
    const a = story('A')
    const b = story('B')
    expect([a.id, b.id]).toEqual(['SOM-1', 'SOM-2'])
    deleteItem(repo, b.id)
    expect(story('C').id).toBe('SOM-3')
    expect(readFileSync(join(repo, '.somni/seq'), 'utf8').trim()).toBe('4')
  })

  it('never hands out an id an existing file already claims (lost seq file)', () => {
    story('A')
    story('B')
    rmSync(join(repo, '.somni/seq'))
    expect(nextId(repo)).toBe('SOM-3')
  })

  it('moves the file when the title changes, keeping the id', () => {
    const a = story('Before')
    const renamed = saveItem(repo, { ...a, name: 'After', slug: '' })
    expect(renamed.id).toBe(a.id)
    expect(existsSync(join(repo, '.somni/items', `${a.id}-before.md`))).toBe(false)
    expect(existsSync(join(repo, '.somni/items', `${a.id}-after.tasks.json`))).toBe(true)
    expect(loadItems(repo)).toEqual([renamed])
  })

  it('setItemStatus rewrites only the status', () => {
    const a = story('A')
    expect(setItemStatus(repo, a.id, 'in-progress').status).toBe('in-progress')
    expect(loadItems(repo)[0]).toEqual({ ...a, status: 'in-progress' })
    expect(() => setItemStatus(repo, 'SOM-99', 'done')).toThrow()
  })

  it('drops the subtask sidecar when an item is not a story', () => {
    const a = story('A')
    saveItem(repo, { ...a, kind: 'epic' })
    expect(existsSync(join(repo, '.somni/items', `${a.id}-a.tasks.json`))).toBe(false)
    expect(loadItems(repo)[0].tasks).toEqual([])
  })
})

// The Ready gate (§4.1) — main is the authority; item:setStatus and
// pipeline:add both refuse on these.
describe('readyBlocker', () => {
  const make = (extra: object): ReturnType<typeof saveItem> =>
    saveItem(repo, {
      name: 'S',
      kind: 'story',
      spec: 'the spec',
      tasks: [{ title: 'T', prompt: 'p', role: 'dev', selected: true }],
      ...extra
    })

  it('passes a groomed story', () => {
    expect(readyBlocker(make({}))).toBeNull()
  })

  it('refuses a missing item, a non-story kind, an empty spec and zero selected subtasks', () => {
    expect(readyBlocker(undefined)).toMatch(/not found/)
    expect(readyBlocker(make({ kind: 'idea' }))).toMatch(/only a Story/)
    expect(readyBlocker(make({ kind: 'epic' }))).toMatch(/only a Story/)
    expect(readyBlocker(make({ spec: '   ' }))).toMatch(/empty Spec/)
    expect(readyBlocker(make({ tasks: [] }))).toMatch(/no selected subtasks/)
    expect(
      readyBlocker(make({ tasks: [{ title: 'T', prompt: 'p', role: 'dev', selected: false }] }))
    ).toMatch(/no selected subtasks/)
  })
})

describe('execution profile & settings resolution', () => {
  it('parses and round-trips role frontmatter', () => {
    mkdirSync(join(repo, '.somni/roles'), { recursive: true })
    writeFileSync(
      join(repo, '.somni/roles/dev.md'),
      '---\nmodel: opus\neffort: high\n---\n# Dev\n\nBe good.\n'
    )
    const role = loadRepo(repo).roles[0]
    expect(role).toEqual({
      slug: 'dev',
      name: 'Dev',
      preamble: 'Be good.',
      model: 'opus',
      effort: 'high'
    })
    saveRole(repo, role)
    expect(loadRepo(repo).roles[0]).toEqual(role)
  })

  it('omits the frontmatter fence when the overrides are cleared', () => {
    saveRole(repo, { slug: 'dev', name: 'Dev', preamble: 'p', model: '', effort: undefined })
    expect(readFileSync(join(repo, '.somni/roles/dev.md'), 'utf8')).toBe('# Dev\n\np\n')
    expect(loadRepo(repo).roles[0]).toEqual({ slug: 'dev', name: 'Dev', preamble: 'p' })
  })

  it('ignores unknown/invalid frontmatter keys', () => {
    mkdirSync(join(repo, '.somni/roles'), { recursive: true })
    writeFileSync(join(repo, '.somni/roles/x.md'), '---\neffort: turbo\nrunner: agy\n---\n# X\n')
    expect(loadRepo(repo).roles[0]).toEqual({ slug: 'x', name: 'X', preamble: '' })
  })

  it('resolves role over repo config over global', () => {
    mkdirSync(join(repo, '.somni'), { recursive: true })
    writeFileSync(join(repo, '.somni/config.json'), '{"model":"repo","concurrency":5}')
    const settings = resolveSettings(repo, { model: 'global', effort: 'low', timeoutMinutes: 10 })
    expect(settings).toMatchObject({
      model: 'repo',
      effort: 'low',
      concurrency: 5,
      timeoutMinutes: 10
    })
    expect(settings.reportStyle).toBe('minimal') // default
    expect(resolveProfile({ model: 'role' }, settings)).toEqual({
      runner: 'claude',
      model: 'role',
      effort: 'low'
    })
    expect(resolveProfile(undefined, settings)).toEqual({
      runner: 'claude',
      model: 'repo',
      effort: 'low'
    })
  })

  it('resolves the runner role → repo → global, defaulting to claude', () => {
    mkdirSync(join(repo, '.somni'), { recursive: true })
    writeFileSync(join(repo, '.somni/config.json'), '{"runner":"antigravity"}')
    const settings = resolveSettings(repo, { runner: 'claude' })
    expect(settings.runner).toBe('antigravity')
    expect(resolveProfile(undefined, settings).runner).toBe('antigravity')
    expect(resolveProfile({ runner: 'claude' }, settings).runner).toBe('claude')
    expect(resolveProfile(undefined, {}).runner).toBe('claude')
  })

  it('round-trips a runner override through role frontmatter', () => {
    saveRole(repo, { slug: 'dev', name: 'Dev', preamble: 'p', runner: 'antigravity' })
    expect(loadRepo(repo).roles[0].runner).toBe('antigravity')
  })
})

describe('backlog ordering', () => {
  it('round-trips ids and prunes ones whose item is gone', () => {
    const a = saveItem(repo, { name: 'A', kind: 'idea' })
    const b = saveItem(repo, { name: 'B', kind: 'idea' })
    saveBacklog(repo, [b.id, a.id, 'SOM-99'])
    expect(loadBacklog(repo)).toEqual([b.id, a.id])
    deleteItem(repo, b.id)
    expect(loadBacklog(repo)).toEqual([a.id])
  })
})

// Session lifecycle (M25.3) — grooming machinery in frontmatter, never a Status.
describe('grooming sessions', () => {
  const day = 86_400_000
  const groom = (name: string, extra = {}): ReturnType<typeof saveItem> =>
    saveItem(repo, { name, kind: 'idea', status: 'grooming', ...extra })

  it('round-trips groomState and doneAt through frontmatter', () => {
    const i = groom('Applied', { groomState: 'done', doneAt: '2026-09-01T00:00:00.000Z' })
    const raw = readFileSync(join(repo, '.somni/items', `${i.id}-applied.md`), 'utf8')
    expect(raw).toContain('groomState: done')
    expect(raw).toContain('doneAt: 2026-09-01T00:00:00.000Z')
    expect(loadItems(repo)[0]).toMatchObject({
      status: 'grooming',
      groomState: 'done',
      doneAt: '2026-09-01T00:00:00.000Z'
    })
  })

  it('ignores an unknown hand-written groomState', () => {
    mkdirSync(join(repo, '.somni/items'), { recursive: true })
    writeFileSync(
      join(repo, '.somni/items/SOM-7-hand.md'),
      '---\nid: SOM-7\nkind: idea\nstatus: grooming\ngroomState: nonsense\n---\n# Hand\n'
    )
    expect(loadItems(repo)[0].groomState).toBeUndefined()
  })

  it('archives only done sessions older than 14 days', () => {
    const now = Date.parse('2026-09-20T00:00:00.000Z')
    const old = groom('Old', { groomState: 'done', doneAt: new Date(now - 15 * day).toISOString() })
    const fresh = groom('Fresh', {
      groomState: 'done',
      doneAt: new Date(now - 13 * day).toISOString()
    })
    const talking = groom('Talking')
    expect(archiveStaleSessions(repo, now)).toEqual([old.id])
    const byId = Object.fromEntries(loadItems(repo).map((i) => [i.id, i]))
    expect(byId[old.id].groomState).toBe('archived')
    expect(byId[fresh.id].groomState).toBe('done')
    expect(byId[talking.id].groomState).toBeUndefined()
    // idempotent: a second sweep finds nothing new
    expect(archiveStaleSessions(repo, now)).toEqual([])
  })

  it('reopen clears the archived state back to an active conversation', () => {
    const i = groom('Old', { groomState: 'archived', doneAt: '2026-08-01T00:00:00.000Z' })
    expect(reopenSession(repo, i.id).groomState).toBeUndefined()
    const raw = readFileSync(join(repo, '.somni/items', `${i.id}-old.md`), 'utf8')
    expect(raw).not.toContain('groomState')
    expect(raw).not.toContain('doneAt')
    expect(loadItems(repo)[0].status).toBe('grooming') // Status is untouched
  })
})
