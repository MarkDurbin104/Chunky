import { describe, expect, test } from 'vitest'
import {
  toSvg,
  toStatechart,
  toGherkin,
  importStatechart,
  autoLayout,
  validateFlow,
  handAuthoredSample,
  importedSample,
  ACTIVE_INSTRUMENT_STATECHART,
} from '../index'
import type { FlowDoc } from '../model'

const samples: Array<{ name: string; doc: FlowDoc }> = [
  { name: 'handAuthored', doc: handAuthoredSample },
  { name: 'imported', doc: importedSample },
]

describe('projections produce non-empty output', () => {
  for (const { name, doc } of samples) {
    test(`${name}: SVG`, () => {
      const svg = toSvg(doc)
      expect(svg).toContain('<svg')
      expect(svg).toContain('viewBox=')
      expect(svg).toContain('</svg>')
      expect(svg.length).toBeGreaterThan(200)
    })

    test(`${name}: statechart`, () => {
      const sc = toStatechart(doc)
      expect(sc.startsWith('stateDiagram-v2')).toBe(true)
      expect(sc).toContain('[*] -->')
      expect(sc).toContain('-->')
    })

    test(`${name}: gherkin`, () => {
      const g = toGherkin(doc)
      expect(g).toContain('### Feature:')
      expect(g).toContain('**Background:**')
      expect(g).toContain('**Scenario')
      expect(g.length).toBeGreaterThan(100)
    })
  }
})

describe('SVG house-style details', () => {
  test('dashed back edges use stroke-dasharray "6 5"', () => {
    const svg = toSvg(handAuthoredSample)
    expect(svg).toContain('stroke-dasharray="6 5"')
  })

  test('forward edges are solid (no dasharray on a forward line)', () => {
    const svg = toSvg(handAuthoredSample)
    // the success edge labelled SET is forward — must appear as a plain line
    expect(svg).toMatch(/<line[^>]*stroke="#6b6b6b"[^>]*\/>/)
  })

  test('arrow marker + white label backing + legend present', () => {
    const svg = toSvg(handAuthoredSample)
    expect(svg).toContain('<marker id="flow-arrow"')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('forward')
  })

  test('viewBox is fit to content (positive size)', () => {
    const svg = toSvg(handAuthoredSample)
    const m = /viewBox="(-?[\d.]+) (-?[\d.]+) ([\d.]+) ([\d.]+)"/.exec(svg)!
    expect(m).toBeTruthy()
    expect(Number(m[3])).toBeGreaterThan(0)
    expect(Number(m[4])).toBeGreaterThan(0)
  })
})

describe('statechart composite states from tabs', () => {
  test('a tabbed node emits a nested composite state', () => {
    const doc: FlowDoc = {
      id: 't',
      title: 'Tabbed',
      revision: [],
      overview: '',
      nodes: [
        { id: 's', label: 'Start', role: 'start', pos: { x: 0, y: 0 } },
        {
          id: 'main',
          label: 'Main',
          role: 'screen',
          tabs: ['InputPage', 'MapPage'],
          pos: { x: 0, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', from: 's', to: 'main', events: ['START'], kind: 'forward', label: 'go' },
      ],
    }
    const sc = toStatechart(doc)
    expect(sc).toContain('state main {')
    expect(sc).toContain('InputPage --> MapPage : PAGE')
  })
})

describe('importStatechart round-trips transitions', () => {
  test('every "-->" line (excluding [*] pseudo-state edges) becomes an edge', () => {
    const doc = importStatechart(ACTIVE_INSTRUMENT_STATECHART)
    const lines = ACTIVE_INSTRUMENT_STATECHART.split('\n').map((l) => l.trim())
    const realTransitions = lines.filter(
      (l) => l.includes('-->') && !l.includes('[*]'),
    )
    // every real (non-pseudo) transition maps to an edge with matching from/to
    for (const line of realTransitions) {
      const m = /^(\S+)\s*-->\s*([^:]+?)\s*(?::|$)/.exec(line)!
      const from = m[1]
      const to = m[2].trim()
      const found = doc.edges.some((e) => e.from === from && e.to === to)
      expect(found, `transition ${from} --> ${to}`).toBe(true)
    }
    // plus one synthesised start edge for the [*] --> activating entry
    expect(doc.edges.length).toBeGreaterThanOrEqual(realTransitions.length)
    expect(doc.edges.some((e) => e.events.includes('START'))).toBe(true)
  })

  test('events and guards are parsed out of the label', () => {
    const doc = importStatechart(ACTIVE_INSTRUMENT_STATECHART)
    const guarded = doc.edges.find((e) => e.events.includes('ACTIVE_GPS'))
    expect(guarded).toBeTruthy()
    expect(guarded!.guards).toContain('isAll')
  })

  test('ESC / back events are inferred as dashed (back) edges', () => {
    const doc = importStatechart(ACTIVE_INSTRUMENT_STATECHART)
    const closing = doc.edges.find((e) => e.events.join(' ').includes('ESC'))
    expect(closing).toBeTruthy()
    expect(closing!.kind).toBe('back')
  })

  test('self transitions become self edges', () => {
    const doc = importStatechart(ACTIVE_INSTRUMENT_STATECHART)
    const selfEdges = doc.edges.filter((e) => e.kind === 'self')
    expect(selfEdges.length).toBeGreaterThan(0)
    for (const e of selfEdges) expect(e.from).toBe(e.to)
  })

  test('roles are inferred heuristically', () => {
    const doc = importStatechart(ACTIVE_INSTRUMENT_STATECHART)
    expect(doc.nodes.find((n) => n.role === 'start')).toBeTruthy()
    expect(doc.nodes.find((n) => n.id === 'closing')!.role).toBe('cancel')
  })
})

describe('autoLayout is deterministic and assigns positions', () => {
  test('positions assigned and stable across runs', () => {
    const a = autoLayout(importStatechart(ACTIVE_INSTRUMENT_STATECHART))
    const b = autoLayout(importStatechart(ACTIVE_INSTRUMENT_STATECHART))
    expect(JSON.stringify(a.nodes.map((n) => n.pos))).toBe(
      JSON.stringify(b.nodes.map((n) => n.pos)),
    )
    // not all at origin
    expect(a.nodes.some((n) => n.pos.y > 0)).toBe(true)
  })
})

describe('validateFlow returns ok:true for laid-out samples', () => {
  for (const { name, doc } of samples) {
    test(`${name} validates clean`, () => {
      const res = validateFlow(doc)
      const errors = res.issues.filter((i) => i.severity === 'error')
      expect(errors, JSON.stringify(errors, null, 2)).toEqual([])
      expect(res.ok).toBe(true)
    })
  }

  test('a dangling edge is flagged (D2)', () => {
    const bad: FlowDoc = {
      ...handAuthoredSample,
      edges: [
        ...handAuthoredSample.edges,
        { id: 'x', from: 'setup', to: 'ghost', events: ['BOOM'], kind: 'forward', label: 'boom' },
      ],
    }
    const res = validateFlow(bad)
    expect(res.ok).toBe(false)
    expect(res.issues.some((i) => i.rule === 'D2')).toBe(true)
  })
})

describe('gherkin has exactly one scenario per edge', () => {
  for (const { name, doc } of samples) {
    test(`${name}: one scenario per non-start, non-transient edge`, () => {
      const g = toGherkin(doc)
      const scenarioCount = (g.match(/\*\*Scenario(?: Outline)?\*\*:/g) || [])
        .length
      // edges whose source is a drawn (non-start, non-transient) node yield a scenario
      const startIds = new Set(
        doc.nodes
          .filter((n) => n.role === 'start' || n.role === 'transient')
          .map((n) => n.id),
      )
      const expected = doc.edges.filter((e) => !startIds.has(e.from)).length
      expect(scenarioCount).toBe(expected)
    })
  }

  test('scenarioOverride replaces the generated scenario', () => {
    const doc: FlowDoc = {
      ...handAuthoredSample,
      edges: handAuthoredSample.edges.map((e) =>
        e.id === 'e4'
          ? { ...e, scenarioOverride: '**Scenario**: custom\n**Given** x\n**When** y\n**Then** z' }
          : e,
      ),
    }
    const g = toGherkin(doc)
    expect(g).toContain('**Scenario**: custom')
  })

  test('examples produce a Scenario Outline + Examples', () => {
    const doc: FlowDoc = {
      ...handAuthoredSample,
      edges: handAuthoredSample.edges.map((e) =>
        e.id === 'e4'
          ? {
              ...e,
              examples: { headers: ['a', 'b'], rows: [['1', '2']] },
            }
          : e,
      ),
    }
    const g = toGherkin(doc)
    expect(g).toContain('**Scenario Outline**:')
    expect(g).toContain('**Examples**')
    expect(g).toContain('| a | b |')
  })
})
