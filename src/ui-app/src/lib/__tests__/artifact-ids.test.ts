import { describe, expect, test } from 'vitest'
import { tagArtifacts } from '../artifact-ids'

describe('tagArtifacts', () => {
  test('stamps art- ids on paragraph and image blocks (returned array)', () => {
    const blocks: any[] = [
      { type: 'paragraph', content: 'hello' },
      { type: 'image', props: { url: 'data:image/png;base64,abc' } },
    ]
    const tagged = tagArtifacts(blocks)
    expect(tagged[0].props.id).toMatch(/^art-/)
    expect(tagged[1].props.id).toMatch(/^art-/)
  })

  test('does not mutate the input array (immutable contract)', () => {
    const blocks: any[] = [{ type: 'paragraph' }]
    tagArtifacts(blocks)
    expect(blocks[0].props).toBeUndefined()
  })

  test('leaves existing art- ids unchanged (idempotent)', () => {
    const blocks: any[] = [
      { type: 'paragraph', props: { id: 'art-stable-1' }, content: 'x' },
    ]
    const once = tagArtifacts(blocks)
    expect(once[0].props.id).toBe('art-stable-1')
    const twice = tagArtifacts(once)
    expect(twice[0].props.id).toBe('art-stable-1')
  })

  test('overwrites non-artifact ids with art- ones', () => {
    const blocks: any[] = [
      { type: 'paragraph', props: { id: 'tmp-not-artifact' } },
    ]
    const tagged = tagArtifacts(blocks)
    expect(tagged[0].props.id).toMatch(/^art-/)
  })

  test('walks children recursively', () => {
    const blocks: any[] = [
      {
        type: 'heading',
        props: { id: 'art-root' },
        children: [
          { type: 'paragraph' },
          { type: 'image', props: { url: 'x' } },
        ],
      },
    ]
    const tagged = tagArtifacts(blocks)
    expect(tagged[0].children[0].props.id).toMatch(/^art-/)
    expect(tagged[0].children[1].props.id).toMatch(/^art-/)
  })

  test('skips non-artifact block types', () => {
    const blocks: any[] = [{ type: 'codeBlock', content: 'x' }]
    const tagged = tagArtifacts(blocks)
    expect(tagged[0].props).toBeUndefined()
  })

  test('produces unique ids across calls', () => {
    const blocks: any[] = [{ type: 'paragraph' }, { type: 'paragraph' }]
    const tagged = tagArtifacts(blocks)
    expect(tagged[0].props.id).not.toBe(tagged[1].props.id)
  })
})
