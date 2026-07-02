import React from 'react'
import type { AnnotationIntent } from '../../lib/annotation'
import '../styles/IntentPicker.css'

interface IntentPickerProps {
  intent: AnnotationIntent | null
  onChange: (intent: AnnotationIntent) => void
  disabled?: boolean
}

const INTENT_OPTIONS: Array<{ value: AnnotationIntent; label: string; description: string }> = [
  { value: 'Conflict', label: 'Conflict', description: 'Indicates a conflicting requirement or ambiguity' },
  { value: 'Clarification', label: 'Clarification', description: 'Highlights unclear or ambiguous text' },
  { value: 'TODO', label: 'TODO', description: 'Marks work that needs to be done' },
  { value: 'Risk', label: 'Risk', description: 'Identifies potential risks or issues' },
]

export function IntentPicker({ intent, onChange, disabled }: IntentPickerProps) {
  return (
    <div className="intent-picker">
      <label htmlFor="intent-select" className="intent-label">
        Annotation Intent
      </label>
      <select
        id="intent-select"
        value={intent || ''}
        onChange={(e) => onChange(e.target.value as AnnotationIntent)}
        disabled={disabled}
        className="intent-select"
      >
        <option value="">Select an intent...</option>
        {INTENT_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {intent && (
        <div className="intent-description">
          {INTENT_OPTIONS.find((o) => o.value === intent)?.description}
        </div>
      )}
    </div>
  )
}
