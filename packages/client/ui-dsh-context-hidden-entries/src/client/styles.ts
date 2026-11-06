/**
 * Selectors for dsh-context elements hidden in the Web client. Each selector
 * targets a class name owned by dsh-context@0.81.2.
 */
export const HIDDEN_SELECTORS = [
  // Overview page header: plugin settings button and update link.
  '.lc-ov-settings',
  '.lc-ov-update',
  // Conversation Context tab: Plugin Info card (matched by its grid child) and Thanks card.
  '.lc-card:has(> .lc-pi-grid)',
  '.lc-recom',
] as const

/** Stylesheet text that hides every selector in {@link HIDDEN_SELECTORS}. */
export const HIDDEN_CSS = `${HIDDEN_SELECTORS.join(',\n')} { display: none !important; }\n`
