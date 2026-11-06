// @vitest-environment jsdom
/** The hidden-entries stylesheet hides the dsh-context elements named in HIDDEN_SELECTORS. */
import { afterEach, expect, it } from 'vitest'
import { HIDDEN_CSS, HIDDEN_SELECTORS } from '../src/client/styles.ts'

afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren() })

function mount(html: string): void {
  const style = document.createElement('style')
  style.textContent = HIDDEN_CSS
  document.head.append(style)
  document.body.innerHTML = html
}

it('hides the overview settings and update links, the Plugin Info card, and the Thanks card', () => {
  mount(`
    <button class="lc-ov-settings">插件设置</button>
    <a class="lc-ov-update">新版本</a>
    <div class="lc-card"><div class="lc-card-title">插件信息</div><div class="lc-pi-grid"></div></div>
    <a class="lc-card lc-recom">感谢</a>
    <div class="lc-card"><div class="lc-card-title">其他卡片</div></div>
  `)
  for (const el of document.querySelectorAll<HTMLElement>('.lc-ov-settings, .lc-ov-update, .lc-card:has(> .lc-pi-grid), .lc-recom')) {
    expect(getComputedStyle(el).display).toBe('none')
  }
  const other = document.querySelector<HTMLElement>('.lc-card:not(:has(> .lc-pi-grid)):not(.lc-recom)')
  expect(other && getComputedStyle(other).display).not.toBe('none')
})

it('lists every hidden selector in the stylesheet', () => {
  for (const selector of HIDDEN_SELECTORS) expect(HIDDEN_CSS).toContain(selector)
})
