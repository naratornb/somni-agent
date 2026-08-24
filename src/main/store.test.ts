import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  slugify,
  ensureSomni,
  loadRepo,
  saveRole,
  deleteRole,
  saveWorkflow,
  deleteWorkflow
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

  it('saves and reloads roles and workflows', () => {
    const role = saveRole(repo, { slug: '', name: 'Senior Tester', preamble: 'You test things.' })
    expect(role.slug).toBe('senior-tester')
    const wf = saveWorkflow(repo, {
      slug: '',
      name: 'Add feature',
      selected: true,
      tasks: [{ title: 'Design', prompt: 'Design it', role: 'senior-tester', selected: true }]
    })
    const data = loadRepo(repo)
    expect(data.roles).toEqual([role])
    expect(data.workflows).toEqual([wf])
  })

  it('deletes files', () => {
    saveRole(repo, { slug: '', name: 'X', preamble: 'p' })
    deleteRole(repo, 'x')
    saveWorkflow(repo, { slug: '', name: 'Y', selected: false, tasks: [] })
    deleteWorkflow(repo, 'y')
    expect(loadRepo(repo)).toEqual({ roles: [], workflows: [] })
    expect(existsSync(join(repo, '.somni/roles/x.md'))).toBe(false)
  })

  it('picks up hand-edited files and survives malformed ones', () => {
    mkdirSync(join(repo, '.somni/workflows'), { recursive: true })
    writeFileSync(join(repo, '.somni/workflows/hand.json'), '{"name":"Hand","tasks":[]}')
    writeFileSync(join(repo, '.somni/workflows/broken.json'), 'not json')
    const data = loadRepo(repo)
    expect(data.workflows).toEqual([{ slug: 'hand', name: 'Hand', selected: false, tasks: [] }])
  })
})
