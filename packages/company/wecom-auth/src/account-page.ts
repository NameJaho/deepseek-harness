/** Local account information page for an already authenticated WeCom member. */
import type { WecomSessionView } from './types.ts'

const copy = {
  en: { title: 'WeCom account', name: 'Name', userId: 'User ID', corpId: 'Corporation ID', role: 'Role', admin: 'Administrator', user: 'Standard user', logout: 'Sign out', failed: 'Sign-out failed. Try again.' },
  zh: { title: '企业微信账号', name: '姓名', userId: '用户 ID', corpId: '企业 ID', role: '角色', admin: '管理员', user: '普通用户', logout: '退出登录', failed: '退出登录失败，请重试。' },
} as const

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character)
}

/** Render credential-free account facts and a local sign-out action.
 * @param session - authenticated member projection without cookies or secrets.
 * @param nonce - CSP nonce for the inline sign-out handler.
 * @param language - supported request locale.
 * @returns standalone account HTML.
 */
export function accountPage(session: WecomSessionView, nonce: string, language: 'en' | 'zh'): string {
  const text = copy[language]
  const displayName = session.displayName ?? session.userId
  const role = session.role === 'admin' ? text.admin : text.user
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${text.title}</title><style>*{box-sizing:border-box}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fb;color:#1f2937}.card{width:min(440px,calc(100vw - 32px));padding:32px;background:#fff;border:1px solid #dbe3ee;border-radius:12px;box-shadow:0 8px 30px #1f29371a}h1{margin:0 0 24px;font-size:24px;font-weight:600}.row{display:grid;grid-template-columns:120px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid #edf1f6}.label{color:#667085}.value{overflow-wrap:anywhere}.actions{margin-top:24px;display:flex;justify-content:flex-end;gap:12px}button{min-height:40px;padding:0 16px;border:0;border-radius:6px;background:#1677ff;color:#fff;font:inherit;cursor:pointer}button:disabled{opacity:.6;cursor:wait}#status{margin-top:12px;color:#c0392b;font-size:13px}</style></head><body><main class="card"><h1>${text.title}</h1><div class="row"><span class="label">${text.name}</span><span class="value">${escapeHtml(displayName)}</span></div><div class="row"><span class="label">${text.userId}</span><span class="value">${escapeHtml(session.userId)}</span></div><div class="row"><span class="label">${text.corpId}</span><span class="value">${escapeHtml(session.corpId)}</span></div><div class="row"><span class="label">${text.role}</span><span class="value">${role}</span></div><div class="actions"><button id="logout" type="button">${text.logout}</button></div><p id="status" role="alert" hidden></p></main><script nonce="${nonce}">const button=document.getElementById('logout');const status=document.getElementById('status');button.addEventListener('click',async()=>{button.disabled=true;try{const response=await fetch('/auth/wecom/logout',{method:'POST',credentials:'same-origin',headers:{origin:location.origin,'x-dsh-auth':'1'}});if(!response.ok)throw new Error();location.replace('/login')}catch{button.disabled=false;status.hidden=false;status.textContent=${JSON.stringify(text.failed)}}});</script></body></html>`
}
