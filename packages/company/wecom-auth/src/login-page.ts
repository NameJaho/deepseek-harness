/** Localized desktop QR shell using the official WeCom login panel. */
import { readFileSync } from 'node:fs'
import type { WecomLoginConfig } from './types.ts'

const background = readFileSync(new URL('../assets/login-background.jpg', import.meta.url)).toString('base64')
const strings = {
  en: { title: 'Enterprise digital portal', method: 'QR code sign-in', scan: 'Scan with WeCom to sign in', failed: 'Sign-in unavailable. Reload to get a new code or contact your administrator.', retry: 'Get a new code' },
  zh: { title: '企业数字化门户', method: '扫码登录', scan: '请使用企业微信扫描二维码登录', failed: '登录暂不可用，请刷新获取新二维码或联系管理员', retry: '重新获取二维码' },
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
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title}</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;color:#333;background:#e6f3ff}.portal{min-height:100vh;min-height:100svh;display:grid;grid-template-columns:1.25fr 1fr}.brand{min-width:0;position:relative;background:#071745}.brand img{position:absolute;width:100%;height:100%;object-fit:contain;object-position:center}.panel{min-width:0;display:flex;align-items:center;justify-content:center;padding:40px 24px;background:linear-gradient(53deg,#fff 26%,#e6f3ff 99%)}.card{width:360px;max-width:100%;min-height:607px;text-align:center}h1{font-size:32px;font-weight:500;margin:0}.subtitle{font-size:14px;margin:0}.method{margin-top:32px;padding:4px;background:#e6f3ff;border-radius:4px}.method span{display:block;padding:10px 0;font-size:16px;font-weight:500;background:#fff;border-radius:4px;box-shadow:0 2px 4px #0000000a}.qr-card{margin-top:44px;padding:24px 0 12px;background:#fff}#qr-wrap{position:relative;width:320px;max-width:100%;margin:0 auto}#qr{width:320px;max-width:100%;min-height:320px;margin:0 auto}#qr-mask{position:absolute;left:0;right:0;top:262px;height:80px;background:#fff;z-index:1;display:none}#status{font-size:14px;line-height:1.6;color:#666;margin:16px 20px 12px;min-height:23px}.retry{display:inline-flex;align-items:center;justify-content:center;min-height:44px;margin:12px 0;padding:0 12px;color:#0673d4;text-decoration:none;font-size:14px}.retry:focus-visible{outline:2px solid #0673d4;outline-offset:2px;border-radius:4px}@media(hover:hover){.retry:hover{text-decoration:underline}}@media(max-width:1080px){.portal{grid-template-columns:1fr}.brand{aspect-ratio:10/9;max-height:380px}.brand img{object-fit:contain}.panel{padding:40px 24px}.card{min-height:0}}@media(max-width:640px){.panel{padding:28px 16px}.brand{max-height:280px}.card{width:360px}h1{font-size:32px}.qr-card{margin-top:32px}}
</style></head><body><main class="portal"><aside class="brand" aria-hidden="true"><img src="data:image/jpeg;base64,${background}" alt=""></aside><section class="panel" aria-labelledby="portal-title"><div class="card"><h1 id="portal-title">${copy.title}</h1><p class="subtitle" lang="en">Enterprise Digital Portal</p><div class="method"><span>${copy.method}</span></div><div class="qr-card"><div id="qr-wrap"><div id="qr"></div><div id="qr-mask"></div></div><p id="status" role="status" hidden></p></div><a class="retry" href="">${copy.retry}</a></div></section></main>
<script nonce="${nonce}">
const config=${data};
const failed=()=>{const status=document.getElementById('status');status.hidden=false;status.textContent=${JSON.stringify(copy.failed)};};
const sdk=document.createElement('script');sdk.src='https://wwcdn.weixin.qq.com/node/open/js/wecom-jssdk-2.3.4.js';sdk.nonce=${JSON.stringify(nonce)};
sdk.onerror=failed;sdk.onload=()=>{try{window.ww.createWWLoginPanel({el:'#qr',params:{login_type:'CorpApp',appid:config.corpId,agentid:config.agentId,redirect_uri:config.redirectUri,state:config.state,redirect_type:'callback',panel_size:'small'},onLoginSuccess:({code})=>{const callback=new URL(config.redirectUri);callback.searchParams.set('code',code);callback.searchParams.set('state',config.state);location.replace(callback.href);},onCheckWeComLogin:({isWeComLogin})=>{const mask=document.getElementById('qr-mask');mask.style.display=isWeComLogin?'block':'none';if(isWeComLogin){const hide=()=>{setTimeout(()=>{if(document.activeElement?.tagName==='IFRAME'){mask.style.display='none';window.removeEventListener('blur',hide);}});};window.addEventListener('blur',hide);}},onLoginFail:failed});}catch(error){failed();}};document.head.append(sdk);
</script></body></html>`
}
