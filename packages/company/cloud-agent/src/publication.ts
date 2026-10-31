/** Authoritative publication questions; the selected answer comes from the human answerer. */
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { CloudAgentRecord, CloudAgentVisibility } from './types.ts'

/** Languages supported by the company publication confirmation. */
export type PublicationLanguage = 'zh' | 'en'

const copy = {
  zh: {
    question: (name: string) => `是否将「${name}」发布到公共空间？`,
    public: '发布到公共空间', publicDetail: '所有已登录成员都可以使用此智能体',
    private: '仅自己使用', privateDetail: '发布为私有智能体，只有你自己可以使用',
    cancel: '暂不发布', cancelDetail: '保留草稿，不发布',
    instructions: '智能体指令', mcp: 'MCP', knowledge: '知识库', skills: '技能',
  },
  en: {
    question: (name: string) => `Publish “${name}” to the public space?`,
    public: 'Public space', publicDetail: 'Every signed-in member can use this agent.',
    private: 'Only me', privateDetail: 'Publish privately so only you can use this agent.',
    cancel: 'Not now', cancelDetail: 'Keep the draft without publishing.',
    instructions: 'Agent instructions', mcp: 'MCP', knowledge: 'Knowledge sources', skills: 'Skills',
  },
}

/**
 * Build a review from the exact saved draft, excluding connection settings.
 * @param record - owner-authorized saved revision.
 * @param language - user's conversation language.
 * @returns one visibility question and complete draft details.
 */
export function publicationQuestion(record: CloudAgentRecord, language: PublicationLanguage): AskUserQuestionItem {
  const t = copy[language]
  return {
    id: 'publish-agent', question: t.question(record.draft.name),
    detail: [record.draft.name, record.draft.description, `${t.instructions}\n${record.draft.instructions}`,
      `${t.mcp}: ${[...record.draft.mcpServers ?? [], ...record.draft.mcpTools ?? []].join(', ')}`,
      `${t.knowledge}: ${(record.draft.knowledgeSources ?? []).join(', ')}`,
      `${t.skills}: ${(record.draft.skills ?? []).join(', ')}`].join('\n\n'),
    options: [
      { label: t.public, description: t.publicDetail },
      { label: t.private, description: t.privateDetail },
      { label: t.cancel, description: t.cancelDetail },
    ],
  }
}

/**
 * Interpret only a single exact offered option; free text never grants publication.
 * @param selected - option labels returned by the human answerer.
 * @param language - language used for the question.
 * @returns confirmed visibility, or undefined for cancel/unrecognized replies.
 */
export function publicationVisibility(selected: readonly string[], language: PublicationLanguage): CloudAgentVisibility | undefined {
  if (selected.length !== 1) return undefined
  if (selected[0] === copy[language].public) return 'public'
  if (selected[0] === copy[language].private) return 'private'
  return undefined
}
