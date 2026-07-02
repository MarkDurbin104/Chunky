/**
 * Geometric UI icons (Heroicons-style, 24x24, stroke=currentColor).
 * Inlined SVG path strings indexed by name. Keep paths short — these are
 * the only icons the redesigned shell + screens use.
 */

export type IconName =
  | 'documents'
  | 'epics'
  | 'browse'
  | 'chat'
  | 'pis'
  | 'references'
  | 'collection'
  | 'docnew'
  | 'settings'
  | 'chevR'
  | 'chevD'
  | 'chevDown'
  | 'edit'
  | 'plus'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'search'
  | 'x'
  | 'trash'
  | 'back'
  | 'paperclip'
  | 'table'
  | 'heading'
  | 'paragraph'
  | 'image'
  | 'sparkles'
  | 'info'
  | 'check'
  | 'alert'
  | 'send'
  | 'grip'
  | 'ticket'
  | 'link'
  | 'beaker'
  | 'bolt'
  | 'filter'
  | 'pin'
  | 'globe'
  | 'refresh'
  | 'folder'

const ICON_PATHS: Record<IconName, string> = {
  documents: '<path d="M8 4h7l4 4v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M14 4v5h5"/><path d="M10 13h6M10 16.5h6"/>',
  epics: '<path d="M12 3 3 7.5 12 12l9-4.5L12 3Z"/><path d="m3 12 9 4.5L21 12"/><path d="m3 16.5 9 4.5 9-4.5"/>',
  browse: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.3 7.3L4 21l1.7-5.7A8 8 0 1 1 21 12Z"/><path d="M8.5 11h7M8.5 14h4"/>',
  pis: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 9.5h17M8 3.5v3M16 3.5v3"/><path d="M7 13h4M7 16.5h7"/>',
  references: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15.5a.5.5 0 0 1-.8.4L12 16l-6.2 3.9a.5.5 0 0 1-.8-.4V4.5Z"/>',
  collection: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/>',
  docnew: '<path d="M8 4h6l4 4v6m0 0v6a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"/><path d="M13 4v5h5"/><path d="M18.5 17.5v5M16 20h5"/>',
  settings: '<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2" fill="var(--surface)"/><circle cx="15" cy="12" r="2" fill="var(--surface)"/><circle cx="9" cy="17" r="2" fill="var(--surface)"/>',
  chevR: '<path d="m9 6 6 6-6 6"/>',
  chevD: '<path d="m6 9 6 6 6-6"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2 2 0 0 0-2.8-2.8L5 17.2V20Z"/><path d="M14.5 8.5 16 10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M18.4 5.6l1.4-1.4M4.2 19.8l1.4-1.4"/>',
  moon: '<path d="M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5Z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  paperclip: '<path d="M19 11.5 12 18.5a4 4 0 0 1-5.7-5.7l7-7a2.5 2.5 0 0 1 3.5 3.5l-7 7a1 1 0 0 1-1.4-1.4l6.3-6.3"/>',
  table: '<rect x="4" y="5" width="16" height="14" rx="1.5"/><path d="M4 10h16M4 14.5h16M10 5v14"/>',
  heading: '<path d="M6 5v14M14 5v14M6 12h8"/><path d="M18 9v10M18 9l2-1"/>',
  paragraph: '<path d="M5 6h14M5 10h14M5 14h9M5 18h11"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="m5 17 4-4 3 3 3-3 4 4"/>',
  sparkles: '<path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z"/><path d="M18 15l.8 2 2 .8-2 .8L18 21l-.8-2-2-.8 2-.8.8-2Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  check: '<path d="M5 12.5 10 17.5 19 7"/>',
  alert: '<path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  send: '<path d="M5 12 20 5l-5 15-3.5-6.5L5 12Z"/>',
  grip: '<circle cx="9" cy="7" r="1.3"/><circle cx="15" cy="7" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="17" r="1.3"/><circle cx="15" cy="17" r="1.3"/>',
  ticket: '<path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2 2 2 0 0 0 0 4 2 2 0 0 1-2 2v0a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2 2 2 0 0 0 0-4Z"/><path d="M14 6v12"/>',
  link: '<path d="M9 15l6-6"/><path d="M11 7.5 12.5 6a3.5 3.5 0 0 1 5 5l-1.5 1.5M13 16.5 11.5 18a3.5 3.5 0 0 1-5-5L8 11.5"/>',
  beaker: '<path d="M9 3h6M10 3v6L5 18a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3"/><path d="M7.5 14h9"/>',
  bolt: '<path d="M13 3 5 13h6l-1 8 8-10h-6l1-8Z"/>',
  filter: '<path d="M4 5h16l-6.5 8v6l-3 2v-8L4 5Z"/>',
  pin: '<path d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6Z"/><path d="M12 15v5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/>',
  refresh: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 16M4 20v-4h4"/>',
  folder: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2.5h6a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z"/>',
}

interface IconProps {
  name: IconName
  size?: number
  style?: React.CSSProperties
  className?: string
}

export function Icon({ name, size, style, className }: IconProps) {
  const d = ICON_PATHS[name] || ''
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      style={style}
      className={className}
      dangerouslySetInnerHTML={{ __html: d }}
    />
  )
}
