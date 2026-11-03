/** Sidebar copy for the member's default-Agent MCP selection. */
export const zh = {
  tab: '个人能力',
  guide: '选择默认智能体可以使用的 MCP 服务',
  title: '默认智能体的 MCP',
  help: '只有勾选的服务会提供工具。未勾选的服务不会出现在新会话中，修改后从下一步生效。',
  empty: '你当前没有可用的 MCP 服务。',
  save: '保存',
  saving: '保存中…',
  saved: '已保存',
  loading: '正在读取…',
  failed: '暂时无法读取或保存，请稍后重试',
  refresh: '刷新',
  selected: '已选 {count} 个',
} as const

export type UserMcpLocaleKey = keyof typeof zh

export const en = {
  tab: 'Personal capabilities',
  guide: 'Choose the MCP servers the default agent may use',
  title: 'MCP for the default agent',
  help: 'Only checked servers provide tools. Unchecked servers are not offered to new sessions; changes apply from the next step.',
  empty: 'You have no MCP servers available.',
  save: 'Save',
  saving: 'Saving…',
  saved: 'Saved',
  loading: 'Loading…',
  failed: 'Could not load or save right now. Try again later.',
  refresh: 'Refresh',
  selected: '{count} selected',
} satisfies Record<UserMcpLocaleKey, string>
