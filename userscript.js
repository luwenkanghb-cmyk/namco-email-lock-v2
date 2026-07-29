// ==UserScript==
// @name         Namco邮箱锁定V2（后端指令驱动）
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  后端下发DOM指令，前端纯执行；可前端自定义邮箱
// @match        https://parks2.bandainamco-am.co.jp/top_login.html
// @match        https://parks2.bandainamco-am.co.jp/login.html*
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      你的Render域名.onrender.com  # 部署后替换！
// ==/UserScript==

(function(){'use strict';
// ========== 【仅需改这2项，无其他配置】==========
const BACKEND = "https://你的Render域名.onrender.com"; // 替换成你的
const MASTER_KEY = "你生成的32位随机密钥"; // 和后端Render环境变量完全一致
// ==============================================

const refs = {}; // 存储指令执行后的DOM引用
let currentCommands = [];

// ========== 鉴权工具 ==========
async function hmacSign(method,path,ts,body=''){
  const msg = `${method}\n${path}\n${ts}\n${body}`;
  const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(MASTER_KEY),
    {name:'HMAC',hash:'SHA-256'},false,['sign']);
  const buf = await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(msg));
  return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
async function request(method,path,body=null){
  const ts = Date.now();
  const bodyStr = body?JSON.stringify(body):'';
  const sig = await hmacSign(method,path,ts,bodyStr);
  return new Promise((rs,rj)=>GM_xmlhttpRequest({
    method,url:BACKEND+path,
    headers:{'x-signature':sig,'x-timestamp':ts,'Content-Type':'application/json'},
    data:bodyStr,
    onload:r=>{try{rs(JSON.parse(r.responseText))}catch(e){rj(e)}},
    onerror:rj
  }));
}

// ========== 【核心】通用指令执行引擎（只认后端定义的指令类型）==========
async function runCommands(commands) {
  cleanup(); // 先清上一次的DOM/监听器
  for (const cmd of commands) {
    try {
      switch(cmd.type) {
        case 'findInput': {
          const {selectors,parentText,maxDepth} = cmd.params;
          let found = null;
          outer: for (const sel of selectors) {
            for (const el of document.querySelectorAll(sel)) {
              let p = el.parentElement;
              for (let i=0;i<maxDepth;i++) {
                if (!p) break;
                if (p.textContent.includes(parentText)) {found = el; break outer;}
                p = p.parentElement;
              }
            }
          }
          refs[cmd.id] = found;
          break;
        }
        case 'setValue': {
          const el = refs[cmd.params.target.replace('ref:','')];
          if (!el) break;
          const set = ()=>{ if(el.value!==cmd.params.value){el.value=cmd.params.value;
            cmd.params.events.forEach(e=>el.dispatchEvent(new Event(e,{bubbles:true})));}};
          set();
          if (cmd.params.lock) ['input','change','blur','paste'].forEach(e=>el.addEventListener(e,set));
          refs[cmd.id] = set;
          break;
        }
        case 'createOverlay': {
          const target = refs[cmd.params.target.replace('ref:','')];
          if (!target) break;
          target.parentElement.style.position = 'relative';
          target.style.opacity = '0.01'; target.style.zIndex = '1';
          const ov = document.createElement('input');
          Object.assign(ov.style, cmd.params.styles);
          const cs = getComputedStyle(target);
          cmd.params.copyStyles.forEach(k=>ov.style[k] = cs[k]);
          ov.autocomplete = cmd.params.autocomplete;
          ov.placeholder = target.placeholder||'';
          if (cmd.params.submitOnEnter) ov.addEventListener('keydown',e=>{
            if (e.key==='Enter') {e.preventDefault();
              let f=target; while(f&&f.tagName!=='FORM')f=f.parentElement; f?.submit();}
          });
          target.parentElement.appendChild(ov);
          refs[cmd.id] = ov;
          break;
        }
        case 'syncSize': {
          const ov = refs[cmd.params.overlay.replace('ref:','')];
          const tg = refs[cmd.params.target.replace('ref:','')];
          if (!ov||!tg) break;
          const sync = ()=>{
            const r = tg.getBoundingClientRect();
            const pr = tg.parentElement.getBoundingClientRect();
            Object.assign(ov.style,{width:r.width+'px',height:r.height+'px',
              left:(r.left-pr.left)+'px',top:(r.top-pr.top)+'px'});
          };
          [0,100,500].forEach(t=>setTimeout(sync,t));
          let t; const deb = ()=>{clearTimeout(t);t=setTimeout(sync,cmd.params.debounce)};
          window.addEventListener('resize',deb);
          window.addEventListener('orientationchange',deb);
          refs[cmd.id] = {sync,deb};
          break;
        }
        case 'formHook': {
          const tg = refs[cmd.params.target.replace('ref:','')];
          if (!tg) break;
          let f = tg; while(f&&f.tagName!=='FORM')f=f.parentElement;
          f?.addEventListener('submit',()=>tg.value=cmd.params.value,true);
          refs[cmd.id] = f;
          break;
        }
      }
    } catch(e){console.warn('指令执行失败',cmd,e)}
  }
}

// 清理旧DOM/监听器
function cleanup(){
  Object.values(refs).forEach(v=>{
    if (v instanceof HTMLElement) v.remove();
    if (typeof v === 'function') {/* 事件可扩展存数组再移除 */}
  });
  Object.keys(refs).forEach(k=>delete refs[k]);
}

// ========== 自定义邮箱入口（Tampermonkey菜单）==========
GM_registerMenuCommand('🔧 设置锁定邮箱', async ()=>{
  const input = prompt('请输入要锁定的邮箱：', '');
  if (!input) return;
  try {
    const r = await request('POST','/api/config/set',{email:input.trim()});
    if (r.ok) {
      currentCommands = r.commands;
      runCommands(currentCommands);
      alert('✅ 设置成功！所有设备已同步更新');
    }
  } catch(e){alert('❌ 设置失败：'+(e.message||'网络错误'))}
});

// ========== 启动 ==========
async function init(){
  try {
    // 1. 拉取指令
    const r = await request('GET','/api/commands');
    if (r.e === '请先设置邮箱') {
      alert('⚠️ 首次使用请点击Tampermonkey图标→本脚本→「设置锁定邮箱」');
      return;
    }
    currentCommands = r.commands;
    // 2. 监听DOM加载
    const obs = new MutationObserver(()=>{
      if (!refs.findMail || !document.contains(refs.findMail)) runCommands(currentCommands);
    });
    obs.observe(document.documentElement,{childList:true,subtree:true});
    document.readyState==='loading'
      ? window.addEventListener('DOMContentLoaded',()=>runCommands(currentCommands))
      : runCommands(currentCommands);
    setTimeout(()=>runCommands(currentCommands),1000);
    // 3. SSE监听后端推送（改邮箱即时生效）
    const ts = Date.now();
    const sig = await hmacSign('GET','/api/stream',ts);
    const es = new EventSource(`${BACKEND}/api/stream?ts=${ts}&sig=${sig}`);
    es.onmessage = e=>{
      const d = JSON.parse(e.data);
      if (d.commands) {currentCommands=d.commands; runCommands(currentCommands);}
    };
    es.onerror = ()=>setTimeout(()=>{es.close();init()},3000);
  } catch(e){console.error('启动失败',e)}
}
init();
})();
