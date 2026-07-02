import { describe, expect, test } from 'vitest'
import { PROMPTS, findPrompt, type SlashContext } from '../templates'

const baseCtx: SlashContext = {
  docBody: 'doc body text',
  selection: '',
  docName: 'My Doc',
  pinnedReferences: [],
  linkedCollections: [],
}

describe('agent prompt templates', () => {
  test('exposes 7 commands with unique ids', () => {
    expect(PROMPTS).toHaveLength(7)
    const ids = new Set(PROMPTS.map((p) => p.id))
    expect(ids.size).toBe(7)
    expect(ids).toEqual(
      new Set(['draft', 'expand', 'cite', 'match-style', 'structure-from', 'summarise', 'ask']),
    )
  })

  test('every template produces a non-empty system + user prompt', () => {
    for (const cmd of PROMPTS) {
      const out = cmd.build({
        ...baseCtx,
        selection: 'sel',
        userInput: 'arg',
        pinnedReferences: [{ id: 'r1', name: 'PMSpec', category: 'pmspec' }],
        linkedCollections: ['00000000-0000-4000-8000-000000000001'],
      })
      expect(out.systemPrompt.length).toBeGreaterThan(20)
      expect(out.userPrompt.length).toBeGreaterThan(5)
    }
  })

  test('replaceSelection is true for expand and match-style only', () => {
    const flags = Object.fromEntries(
      PROMPTS.map((p) => [p.id, p.build({ ...baseCtx, selection: 'sel' }).replaceSelection]),
    )
    expect(flags.expand).toBe(true)
    expect(flags['match-style']).toBe(true)
    expect(flags.draft).toBe(false)
    expect(flags.cite).toBe(false)
    expect(flags['structure-from']).toBe(false)
    expect(flags.summarise).toBe(false)
    expect(flags.ask).toBe(false)
  })

  test('findPrompt returns the right command', () => {
    expect(findPrompt('draft')?.id).toBe('draft')
    expect(findPrompt('does-not-exist')).toBeUndefined()
  })

  test('expand requires a non-empty selection (per requiresSelection flag)', () => {
    const expand = findPrompt('expand')!
    expect(expand.requiresSelection).toBe(true)
  })

  test('cite prompt mentions linkedCollections when supplied', () => {
    const cite = findPrompt('cite')!
    const out = cite.build({
      ...baseCtx,
      selection: 'sel',
      linkedCollections: ['aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'],
    })
    expect(out.userPrompt).toContain('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa')
  })
})
