// Closed-set contract test for `WorkspaceType` (B-017).
// Compile-time assertion: each Authoring Phase literal must be assignable
// TO `WorkspaceType`, and the legacy `requirement` literal must NOT be.
// The runtime body is a no-op; the value of these tests is in `tsc --noEmit`.

import { describe, expect, test } from 'vitest'
import type { WorkspaceType } from '../types'

describe('WorkspaceType closed set', () => {
  test('includes Authoring Phase literals', () => {
    const _pi: WorkspaceType = 'product_increment'
    const _ac: WorkspaceType = 'artifact_collection'
    const _rd: WorkspaceType = 'requirement_document'
    const _ep: WorkspaceType = 'epic'
    const _rf: WorkspaceType = 'reference'
    void _pi
    void _ac
    void _rd
    void _ep
    void _rf
    expect(true).toBe(true)
  })

  test('includes the v1 carry-over literals', () => {
    const _component: WorkspaceType = 'component'
    const _interface: WorkspaceType = 'interface'
    const _constraint: WorkspaceType = 'constraint'
    const _decision: WorkspaceType = 'decision'
    const _risk: WorkspaceType = 'risk'
    const _testcase: WorkspaceType = 'testcase'
    const _annotation: WorkspaceType = 'annotation'
    const _evidence: WorkspaceType = 'evidence'
    const _draft: WorkspaceType = 'draft'
    void _component
    void _interface
    void _constraint
    void _decision
    void _risk
    void _testcase
    void _annotation
    void _evidence
    void _draft
    expect(true).toBe(true)
  })

  test('excludes the legacy `requirement` literal', () => {
    // @ts-expect-error — `requirement` was removed by B-017.
    const _legacy: WorkspaceType = 'requirement'
    void _legacy
    expect(true).toBe(true)
  })
})
