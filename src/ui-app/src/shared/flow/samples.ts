// shared/flow/samples.ts — concrete FlowDocs used by tests and demos.
//
//  (a) `handAuthoredSample` — a small, hand-laid-out flow.
//  (b) `importedSample`     — produced by importStatechart() + autoLayout() on a
//      REAL stateDiagram-v2 block copied verbatim from
//      docs/flows/apps/active-instrument-selection.md, proving the import path
//      end-to-end.

import type { FlowDoc } from './model'
import { importStatechart } from './import'
import { autoLayout } from './layout'

// (a) Hand-authored: a tiny Total-Station-style setup flow, pre-laid-out so it
// validates clean without autoLayout.
export const handAuthoredSample: FlowDoc = {
  id: 'sample__setup',
  title: 'Total Station Setup',
  revision: [{ version: '0.1', date: '2026-06-17', author: 'Mark Durbin' }],
  overview:
    'Operator activates the setup, picks a point, and either completes or backs out.',
  legendNotes: ['blocked SET stays on screen'],
  nodes: [
    { id: 'start', label: 'Start', role: 'start', pos: { x: 220, y: 0 } },
    {
      id: 'setup',
      label: 'Total Station Setup',
      subtitle: 'setupController',
      role: 'screen',
      pos: { x: 160, y: 170 },
    },
    {
      id: 'choose',
      label: 'Choose Setup Point',
      role: 'screen',
      pos: { x: 160, y: 350 },
    },
    {
      id: 'settings',
      label: 'Settings',
      role: 'subdialog',
      pos: { x: 460, y: 178 },
    },
    {
      id: 'done',
      label: 'Setup Complete',
      role: 'success',
      pos: { x: 170, y: 530 },
    },
  ],
  edges: [
    {
      id: 'e1',
      from: 'start',
      to: 'setup',
      events: ['START'],
      kind: 'forward',
      label: 'start',
    },
    {
      id: 'e2',
      from: 'setup',
      to: 'settings',
      events: ['SHF1'],
      kind: 'forward',
      label: 'open settings',
    },
    {
      id: 'e3',
      from: 'settings',
      to: 'setup',
      events: ['ESC'],
      kind: 'back',
      label: 'ESC',
    },
    {
      id: 'e4',
      from: 'setup',
      to: 'choose',
      events: ['OK'],
      kind: 'forward',
      label: 'OK',
    },
    {
      id: 'e5',
      from: 'choose',
      to: 'choose',
      events: ['SELECT_POINT'],
      kind: 'self',
      label: 'pick point',
    },
    {
      id: 'e6',
      from: 'choose',
      to: 'done',
      events: ['SET'],
      kind: 'forward',
      label: 'SET',
      message: { text: 'Setup stored successfully.', verify: true },
    },
    {
      id: 'e7',
      from: 'choose',
      to: 'setup',
      events: ['ESC'],
      kind: 'back',
      label: 'ESC',
    },
  ],
}

// (b) A REAL stateDiagram-v2 block copied verbatim from
// docs/flows/apps/active-instrument-selection.md.
export const ACTIVE_INSTRUMENT_STATECHART = `stateDiagram-v2
    [*] --> activating
    activating --> InstrumentSelection

    InstrumentSelection --> InstrumentSelection : SELECT_GNSS / chooseGnss
    InstrumentSelection --> InstrumentSelection : SELECT_TPS / chooseTps
    InstrumentSelection --> InstrumentSelection : SELECT_ALL / chooseAll
    InstrumentSelection --> InstrumentSelection : ACTIVE_GPS [isAll] / setActiveGps
    InstrumentSelection --> InstrumentSelection : ACTIVE_TPS [isAll] / setActiveTps
    InstrumentSelection --> confirming : F1 / OK
    InstrumentSelection --> closing : CLOSE / ESC

    confirming --> closingConfirmed
    closingConfirmed --> garbageCollecting

    closing --> InstrumentSelection : CLOSE_VETOED
    closing --> garbageCollecting : CONFIRM_CLOSE

    garbageCollecting --> Closed : APP_CLOSED
    Closed --> [*]`

export const importedSample: FlowDoc = autoLayout(
  importStatechart(ACTIVE_INSTRUMENT_STATECHART),
)
