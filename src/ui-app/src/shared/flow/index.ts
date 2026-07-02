// shared/flow — framework-free Flow Studio core library.
// Public API surface: the §3 model, the house style, the three projections,
// import, auto-layout, validation, and sample documents.

export * from './model'
export * from './style'
export * from './geometry'
export { toSvg } from './projections/svg'
export { toStatechart } from './projections/statechart'
export { toGherkin } from './projections/gherkin'
export { importStatechart } from './import'
export { autoLayout, declashLabels } from './layout'
export {
  makeEmptyDoc,
  addNode,
  updateNode,
  moveNode,
  removeNode,
  addEdge,
  updateEdge,
  moveEdgeLabel,
  removeEdge,
} from './edit'
export { validateFlow } from './validate'
export type { Issue, Severity, ValidationResult } from './validate'
export {
  handAuthoredSample,
  importedSample,
  ACTIVE_INSTRUMENT_STATECHART,
} from './samples'
