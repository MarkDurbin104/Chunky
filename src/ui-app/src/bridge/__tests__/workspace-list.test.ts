// A-017 contract: WorkspaceListRequest and WorkspaceListItem expose `piId`
// optionally. Compile-time checks; runtime body is a no-op.

import { describe, expect, test } from 'vitest'
import type {
  WorkspaceListItem,
  WorkspaceListRequest,
  WorkspaceListResponse,
} from '../types'

describe('A-017 workspace_list shape', () => {
  test('WorkspaceListRequest carries optional piId', () => {
    const req: WorkspaceListRequest = { piId: 'pi-1' }
    const reqNoPi: WorkspaceListRequest = {}
    expect(req.piId).toBe('pi-1')
    expect(reqNoPi.piId).toBeUndefined()
  })

  test('WorkspaceListItem exposes piId when set', () => {
    const item: WorkspaceListItem = {
      id: 'n1',
      path: '/tmp/n1.json',
      type: 'artifact_collection',
      updatedAtUtc: '2026-01-01T00:00:00Z',
      piId: 'pi-1',
    }
    expect(item.piId).toBe('pi-1')
  })

  test('WorkspaceListResponse shape composes', () => {
    const resp: WorkspaceListResponse = { items: [] }
    expect(resp.items).toEqual([])
  })
})
