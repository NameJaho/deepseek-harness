/** Localized desktop QR shell using the official WeCom login panel. */
import type { WecomLoginConfig } from './types.ts'

const strings = {
  en: { title: 'Sign in with WeCom', scan: 'Scan with WeCom to sign in', failed: 'Sign-in unavailable. Reload to get a new code or contact your administrator.', retry: 'Get a new code' },
  zh: { title: '企业微信登录', scan: '请使用企业微信扫码登录', failed: '登录暂不可用，请刷新获取新二维码或联系管理员。', retry: '重新获取二维码' },
}

/** Render a credential-free QR page with browser-local callback navigation.
 * @param config - public application identifiers and browser-bound state.
 * @param nonce - CSP nonce for this response.
 * @param language - supported request locale.
 * @returns standalone HTML; app secret and app access token are never included.
 */
export function loginPage(config: WecomLoginConfig, nonce: string, language: 'en' | 'zh'): string {
  const copy = strings[language]
  const data = JSON.stringify(config).replace(/</g, '\\u003c')
  return `<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title>
<style>body{font-family:system-ui;margin:0;min-height:100vh;display:grid;place-items:center}main{text-align:center;padding:24px;max-width:420px}#qr{min-height:320px}a{display:inline-block;margin:16px}</style>
<main><h1>${copy.title}</h1><div id="qr"></div><p id="status" role="status">${copy.scan}</p><a href="">${copy.retry}</a></main>
<script nonce="${nonce}">
const config=${data};
const failed=()=>{document.getElementById('status').textContent=${JSON.stringify(copy.failed)};};
const sdk=document.createElement('script');sdk.src='https://wwcdn.weixin.qq.com/node/open/js/wecom-jssdk-2.3.4.js';sdk.nonce=${JSON.stringify(nonce)};
sdk.onerror=failed;sdk.onload=()=>{try{window.ww.createWWLoginPanel({el:'#qr',params:{login_type:'CorpApp',appid:config.corpId,agentid:config.agentId,redirect_uri:config.redirectUri,state:config.state,redirect_type:'callback',panel_size:'small'},onLoginSuccess:({code})=>{const callback=new URL(config.redirectUri);callback.searchParams.set('code',code);callback.searchParams.set('state',config.state);location.replace(callback.href);},onLoginFail:failed});}catch(error){failed();}};document.head.append(sdk);
</script></html>`
}
