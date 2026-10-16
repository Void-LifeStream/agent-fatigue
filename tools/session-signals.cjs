#!/usr/bin/env node
'use strict';
/**
 * session-signals.cjs — 「那道闸」：会话体量 + 自中断信号
 *
 * 为什么有它：2026-10-16：一个长会话在累计 303M cache-read tokens 后频繁自中断、思考链退化，不可恢复，
 * 只能归档。我们**没有**任何证据表明"体量大 ⇒ 会坏"（同一台机器上有 170M 的会话活得好好的，
 * 也有刚开的会话就空转）—— 所以这个脚本**不诊断任何东西**，它只做两件事：
 *   ① 让「大」这件事可见（体量分级 + 最大的三个 + 我们这台机器合计）
 *   ② 数一数「被"继续"推过几次」—— 那是自中断**已经发生**的证据（用户提出的判据，
 *      比任何 token 统计都准：不依赖估算、直接对应真实故障、而且出现得早）
 *
 * ⚠️ 它是**提示**，不是判决书：被推过几次之后照常干一整天的会话，我们这台机器就有。
 * ⚠️ 它**救不回已经退化的会话** —— 它只为下一个。
 *
 * 用法：
 *   node session-signals.cjs                 # 紧凑 2 行（给 inflight.ps1 用）
 *   node session-signals.cjs --full          # 完整表格 + 判据说明（人看）
 *   node session-signals.cjs --json          # 机器可读
 *   node session-signals.cjs --self-test     # 自测（造样例日志，验证分级与计数，不碰真日志）
 *
 * 选项：
 *   --dir <path>        会话根目录（默认 ~/.dsh/sessions）—— 自测/换机时用
 *   --me <id>           标记"本会话"（默认取环境变量 DSH_SESSION_ID 后 6 位）
 *   --tier1 <MB>        低档上限（默认 50）
 *   --tier2 <MB>        中档上限（默认 150）
 *   --thresh <N>        "可以考虑收尾"的「继续」次数阈值（默认 3）
 *   --recent <H>        "最近有活动"的小时数（默认 24）
 *   --top <N>           显示几个最大的（默认 3）
 *   --no-titles         不读 projcache 标题（更快）
 *   --no-cache          不用解析缓存（全量重算；验收/审计时用）
 *   --verify-cache      抽 5 个命中缓存的会话全量重算并与缓存比对（审计缓存可信度）
 *
 * 性能（我们实测 2026-10-16，395 个日志 / 94.7 MB）：
 *   全量解压 ≈ 2.3 s；命中缓存后 ≈ 0.2 s。缓存按**文件大小**做键（日志只追加 ⇒ size 变即重算），
 *   缓存文件是 `~/.dsh/inflight/session-signals.cache.json` —— 本工具自己的簿记，不是共享状态；
 *   它坏掉 / 被删只会退回全量重算，**不会**给出错误的闸。
 *
 * 数据来源与判据（全部实测于我们这台机器 2026-10-16）：
 *   · 体量 = `~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd` 的**压缩后**字节数。
 *     ⚠️ 压缩比实测约 3.5x（6.66 MB → 23.0 MB）；别把它当"上下文大小"读。
 *     ⚠️ 303M tokens 那次故障会话的日志只有 4.94 MB ⇒ 按 50 MB 分级，我们这台机器**永远不会有会话越线**。
 *        分级阈值可用 --tier1/--tier2 调；它只是"可见性"，不是风险刻度。
 *   · 「继续」= `user/message` 且 `data.source.kind === 'user'`（真人在打字；同一事件流里还有
 *     agent-instructions / runtime-context / dsh-mnemon 等 15 种注入型 user/message，必须排除）
 *     且整串文本匹配"继续"类。**整串匹配**（不是包含）：宁可漏报，不可误报 ——
 *     用户说"继续用 A 方案"不该被算成"被推"。
 *   · 空转（--full 才有）= `assistant/message` 里既无 text 也无 tool-call（只有 reasoning）。
 *     ⚠️ 它在一次性子代理会话上会**误报**（我们这台机器大量 0.08 MB 的子代理日志恰好是 1/1），
 *     所以它只作参考列，**不作判据**。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULTS = { tier1MB: 50, tier2MB: 150, thresh: 3, recentHours: 24, top: 3 };

// 「继续」类：整串匹配（允许尾随语气词与标点）。分类原因见文件头。
const CONTINUE_RE = new RegExp(
  '^\\s*(?:请|你|可以|麻烦|那就|那)?\\s*' +
  '(?:继续|接着|往下|然后呢|继\\s*续|continue|go\\s+on|go\\s+ahead|carry\\s+on|keep\\s+going|proceed)' +
  '\\s*(?:吧|了|啊|哦|喵|呀|呢|嘛|哟)?\\s*[。.!！~～，,]*\\s*$',
  'i'
);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
function opt(name, def) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def;
}
function flag(name) { return argv.includes('--' + name); }

const OPTS = {
  dir: opt('dir', path.join(os.homedir(), '.dsh', 'sessions')),
  projCache: opt('proj-cache', path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')),
  me: opt('me', (process.env.DSH_SESSION_ID || '').slice(-6)),
  tier1MB: parseFloat(opt('tier1', DEFAULTS.tier1MB)),
  tier2MB: parseFloat(opt('tier2', DEFAULTS.tier2MB)),
  thresh: parseInt(opt('thresh', DEFAULTS.thresh), 10),
  recentHours: parseFloat(opt('recent', DEFAULTS.recentHours)),
  top: parseInt(opt('top', DEFAULTS.top), 10),
  titles: !flag('no-titles'),
  cache: !flag('no-cache'),
  cachePath: opt('cache-file', path.join(os.homedir(), '.dsh', 'inflight', 'session-signals.cache.json')),
  verifyCache: flag('verify-cache'),
  full: flag('full'),
  json: flag('json'),
  selfTest: flag('self-test'),
};

const CACHE_VERSION = 6;   // ⚠️ **任何**会影响数值的改动都必须 +1 —— 不只是"加了字段"：
                           //    字段集、**算法、阈值**、归一化规则，全都算。
                           //    真踩过（2026-10-16）：同一次改动里既升版本（2→3）又把"催促趋势"的
                           //    最小轮数从 5 改成 10 ⇒ 第一次跑把**旧算法**的值写进盘，第二次跑复用了它
                           //    ⇒ 一只只有 5 轮的会话照样报出 6.4× 的假趋势。缓存不是"快一点"，
                           //    它是**判据的一部分**：假命中会让闸给出错误的数字，比慢几秒糟得多。

// ---------- 解析缓存 ----------
function loadCache() {
  try {
    const o = JSON.parse(fs.readFileSync(OPTS.cachePath, 'utf8'));
    if (!o || o.version !== CACHE_VERSION) return {};   // 版本不匹配 ⇒ 整体作废，全量重算
    return o.sessions || {};
  } catch (e) { return {}; }
}
function saveCache(sessions) {
  try {
    fs.mkdirSync(path.dirname(OPTS.cachePath), { recursive: true });
    fs.writeFileSync(OPTS.cachePath, JSON.stringify({
      version: CACHE_VERSION,
      savedAt: new Date().toISOString(),
      note: 'session-signals.cjs 的解析缓存（键=会话目录名，命中判据=日志字节数完全相同）。'
        + '删掉它只会让下一次全量重算，不会出错；共享状态不在这里。',
      sessions,
    }, null, 1) + '\n', 'utf8');
  } catch (e) { /* 缓存写不进去不是错误：下次全量重算即可 */ }
}

// ---------- 已登记的用户会话（workspace.json）----------
// 为什么需要：sessions 目录里有几百个**一次性子代理**日志（0.08 MB 居多），
// 把它们算成"活跃会话"会给出严重误导的数字（实测 278 个）。真正用户能打开的是这张表里的。
function readRegisteredSessions() {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh', 'storages', 'workspace.json'), 'utf8'));
    const set = new Set();
    const ws = (o.tables && o.tables.workspaces) || {};
    for (const k of Object.keys(ws)) {
      for (const id of (ws[k].sessionIds || [])) set.add(String(id).replace(/^session-/, ''));
    }
    return set;
  } catch (e) { return null; }
}

// ---------- 多帧 zstd 解码 ----------
// Node 的 zstdDecompressSync 只解第一帧，所以按魔数 28 B5 2F FD 切帧逐帧解。
// 贪婪：候选切点解压失败时向后再找一个魔数重试 —— 压缩数据内部**也可能**出现这个 4 字节序列，
// 简单切法会把真帧劈成两半、两半都解不开 ⇒ 静默丢一整帧。
function decodeAll(buf) {
  const cuts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { cuts.push(i); i += 4; }
  cuts.push(buf.length);
  const parts = [];
  let bad = 0, ki = 0;
  while (ki < cuts.length - 1) {
    let ok = false;
    for (let kj = ki + 1; kj < cuts.length; kj++) {
      // 防呆：一次尝试超过 64 MB 就不再扩展（正常帧远小于此）
      if (cuts[kj] - cuts[ki] > 64 * 1024 * 1024) break;
      try {
        parts.push(zlib.zstdDecompressSync(buf.subarray(cuts[ki], cuts[kj])));
        ki = kj; ok = true; break;
      } catch (e) { /* 帧尾还没到（或最后一帧不完整）→ 扩展 */ }
    }
    if (!ok) { bad++; ki++; }
  }
  return { parts, bad };
}

// 「自我催促」：快 / 立刻 / 必须 / 别啰嗦 / 要短 ……
// ⚠️ 它不是"病"——健康会话也写（session E 有 455 处、session F 有 501 处，密度 0.3–0.7/千字且**平稳**）。
// **区别在趋势**：病程推进会逼出越来越多自我催促。
//   实测分段密度（每千字）：session A 0.35→0.46→1.79→1.91→**2.80**（8×）；session B 0.34→0.39→0.58→1.66→**3.80**（11×）
//   对照健康：session E 0.64→…→0.35（0.55×）、session F 0.32→…→0.54（1.7×）
// ⇒ 这是**目前最早**的信号（比空转早 10–20 轮），也是唯一一个"能提示该慢下来"的信号。
const URGENT_RE = /(立刻|马上|赶紧|快点|快速|快一点|必须|别啰嗦|不啰嗦|简洁|精简|要短|短一点|立即|直接进入|一次调用|一气呵成|别再|少说|抓紧)/g;

// ⚠️ **咒语只有是"催促句"时才是病征**（2026-10-16 修正，一次真实的误诊）：
//   · `session B` 的咒语是「**做。**」= 命令自己动手 ⇒ 病程 ✓
//   · `session A`（30 次「好。」）· `session C`（202 次「好。」）· `session D`（48 次「嗯。」）
//     用的是**收束词**（"好，那么…"）⇒ 那是**写作风格**，不是退化。
//   证据：`session C` 的「好。」**从第 12 轮起就一直在**（8→14→15→13→18→56→202→35~87 全程起伏），
//   而 `session B` 是**平稳 3–18 → t46 突增 126 → t48 爆到 431** —— 一个是风格，一个是爆发。
//   ⇒ 不区分词性的话，**每一个只是写得啰嗦的会话都会被误诊**。
const SPELL_URGENT_RE = /^(做|执行|立刻|马上|动手|干|上|来|快|写|跑|查|搞|弄|改|修|开始|继续|走)/;

// 催促句的重复分档（**只对催促词生效**；收束词一律不算，见上）
const SPELL_L4 = 100;   // 终末：实测那只 431 次「做。」
const SPELL_L3 = 30;    // 进展：补漏报 —— 若只有 87 次「做。」却因 <100 而判 L0，就漏了

// ---------- 单个会话分析 ----------
// 「自救咒语」：模型空转（想完就停）之后，会用 "做。" / "好。" / "执行。" 这类**极短行**
// 逼自己行动。这个补偿行为本身会循环 —— 实测倒下的那只，这个字的密度从 1.1‰ 涨到 74‰
// （431 次"做。"），而健康会话最高只有 8~16。判据**不绑字面**，只看：
//   剥掉代码块后，归一化的行里「长度 ≤ 6 且是"话"」的同一行重复了几次。
// ⚠️ 必须剥代码块：否则 JSON 的 `}`、`js` 会被当成咒语（第一版就踩了）。
function normLine(l) {
  return l.replace(/[*`_~#>|\-\[\]()]/g, ' ')
    .replace(/[✓✗⚠️✅❌🔔📏📋🎉⇒]/gu, ' ')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function selfPrompt(reasoning) {
  const cnt = new Map();
  let inCode = false;
  for (const raw of reasoning.split('\n')) {
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const l = normLine(raw);
    if (!l || l.length > 6) continue;
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(l)) continue;
    if (/[{}()\[\];=<>$]/.test(l)) continue;
    cnt.set(l, (cnt.get(l) || 0) + 1);
  }
  let maxRep = 0, unit = '';
  for (const [k, v] of cnt) if (v > maxRep) { maxRep = v; unit = k; }
  return { maxRep, unit };
}

function analyze(file) {
  let raw;
  try { raw = fs.readFileSync(file); } catch (e) { return null; }
  const { parts, bad } = decodeAll(raw);
  const text = Buffer.concat(parts).toString('utf8');
  let continues = 0, userTurns = 0, emptySteps = 0, asst = 0, turns = 0;
  let maxRep = 0, maxRepUnit = '';
  const continueTexts = [];
  const perTurnUrgent = new Map();   // turn -> { len, urgent }（算"自我催促"的趋势用）
  // 每个 turn 的**最后一步**是否"只有思考、没有输出" —— 那才是"这一轮自己停了、
  // 用户必须说继续"的机械原因（实测：零号 24/58 轮、倒下的 11/48 轮，健康会话 ≤2）
  const lastStepEmptyByTurn = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (e) { continue; }
    if (r.type === 'user/message') {
      const kind = (r.data && r.data.source && r.data.source.kind) || '';
      if (kind !== 'user') continue;              // 注入型 user/message 一律不算
      userTurns++;
      const txt = ((r.data && r.data.content) || [])
        .filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (CONTINUE_RE.test(txt)) { continues++; if (continueTexts.length < 3) continueTexts.push(txt.trim()); }
    } else if (r.type === 'assistant/message') {
      asst++;
      const content = (r.data && r.data.message && r.data.message.content) || [];
      const hasOut = content.some(c => (c.type === 'text' && c.text && c.text.trim()) || /tool/.test(c.type || ''));
      if (!hasOut) emptySteps++;
      lastStepEmptyByTurn.set(r.data.turn, !hasOut);
      const reasoning = content.filter(c => c.type === 'reasoning').map(c => c.text).join('\n');
      if (reasoning) {
        const sp = selfPrompt(reasoning);
        if (sp.maxRep > maxRep) { maxRep = sp.maxRep; maxRepUnit = sp.unit; }
        const u = reasoning.match(URGENT_RE);
        const acc = perTurnUrgent.get(r.data.turn) || { len: 0, urgent: 0 };
        acc.len += reasoning.length;
        acc.urgent += u ? u.length : 0;
        perTurnUrgent.set(r.data.turn, acc);
      }
    } else if (r.type === 'turn/start') {
      turns++;
    }
  }
  let stallTurns = 0;
  for (const v of lastStepEmptyByTurn.values()) if (v) stallTurns++;
  // ---- 发作（episode）检测：病程不是单调的，而是「发作—缓解—再发作」----
  // 实测（2026-10-16）：两只病重的会话**都曾经自己缓解过** 6–10 轮
  //   session A：3333333 222222 ··········（10 轮健康）2233444444… ← 第二次发作后再没缓解
  //   session B：········22222222······（6 轮健康）222222222233444
  // ⇒ **刚病一点不必换人**（自愈常见）；**第二次发作 = 不归点**（此后再无缓解）。
  // ⚠️ 簇内必须 ≥2 次空转才算"一次发作"：健康会话本来就有 0–1 次（session E 与 session F 各 1 次），
  //    把单次空转当发作会让每一只都"生病"。
  const stallTurnList = [...lastStepEmptyByTurn.entries()].filter(([, v]) => v).map(([t]) => t).sort((a, b) => a - b);
  const episodes = [];
  for (const t of stallTurnList) {
    const last = episodes[episodes.length - 1];
    if (last && t - last.end <= 3) { last.end = t; last.count++; }
    else episodes.push({ start: t, end: t, count: 1 });
  }
  const realEpisodes = episodes.filter(e => e.count >= 2);
  const allTurnList = [...new Set([...perTurnUrgent.keys(), ...lastStepEmptyByTurn.keys()])].sort((a, b) => a - b);
  const lastEp = realEpisodes[realEpisodes.length - 1];
  const roundsAfterLast = lastEp ? allTurnList.filter(t => t > lastEp.end).length : 99;
  const inEpisode = !!lastEp && roundsAfterLast < 5;   // 最后一次发作还没有缓解
  // 「自我催促」趋势：把有 reasoning 的轮次按时间分五段，比首段与末段的密度
  const tKeys = [...perTurnUrgent.keys()].sort((a, b) => a - b);
  const density = (keys) => {
    let len = 0, u = 0;
    for (const k of keys) { const v = perTurnUrgent.get(k); len += v.len; u += v.urgent; }
    return len ? u / len * 1000 : 0;
  };
  // ⚠️ **必须 ≥10 轮**才算趋势：短会话分五段每段只有 1–2 轮，某一轮偶然写了几次"必须/立刻"
  //    就会算出天文数字（实测踩到：session H 只有 6 轮，算出 6.4× 却是误报）。
  //    机理上也说得通 —— 病程需要时间推进，几轮的会话谈不上"推进"。
  let urgentEarly = 0, urgentLate = 0, urgentTrend = 1;
  if (tKeys.length >= 10) {
    const per = Math.max(1, Math.ceil(tKeys.length / 5));
    urgentEarly = density(tKeys.slice(0, per));
    urgentLate = density(tKeys.slice(-per));
    // 首段极低时用一个下限 0.2 兜底，免得短会话算出无穷大
    urgentTrend = urgentEarly >= 0.2 ? urgentLate / urgentEarly : (urgentLate >= 1 ? urgentLate / 0.2 : 1);
  }
  // ---- 病程分级（L0–L4）：**按"发作了几次 + 有没有缓解"划，不按"此刻状态"划** ----
  // L0 健康      ：没有发作
  // L1 紧张(前兆)：催促趋势起来了，但还没有发作（还没真停）—— **别问"你怎么了"，观察即可**
  // L2 单次发作  ：发作过 1 次，且**已经缓解**（≥5 轮没再停）—— **自愈常见，不换人**
  // L3 反复/未缓解：第 2 次发作，或这次发作还没缓解 —— **准备交接（不打断她手头的活）**
  // L4 终末      ：自救咒语 ≥100（那只 431 的结局）—— **立即交接**
  let stage = 0;
  // ⚠️ 咒语要**既是高重复、又是催促词**才算终末：见 SPELL_URGENT_RE 上面的注释（一次真实误诊）
  const spellUrgent = maxRep >= 1 && SPELL_URGENT_RE.test(maxRepUnit);
  if (spellUrgent && maxRep >= SPELL_L4) stage = 4;                 // 催促句重复 ≥100 ⇒ 终末
  else if (realEpisodes.length >= 2 || inEpisode) stage = 3;        // 反复发作 / 这次还没缓解
  else if (spellUrgent && maxRep >= SPELL_L3) stage = 3;            // 催促句 ≥30 ⇒ 也算进展（补漏报）
  else if (realEpisodes.length === 1) stage = 2;                    // 单次发作（已缓解）
  else if (urgentTrend >= 3 && urgentLate >= 1.0) stage = 1;        // 只是紧张
  const stageName = 'L' + stage;
  return {
    continues, userTurns, emptySteps, asst, turns, stallTurns, maxRep, maxRepUnit, spellUrgent,
    urgentEarly, urgentLate, urgentTrend, badFrames: bad, continueTexts,
    episodes: realEpisodes.length, inEpisode, roundsAfterLast, stage, stageName,
  };
}

// ---------- 读标题（projcache）----------
function readTitle(dirName) {
  if (!OPTS.titles) return '';
  try {
    const p = path.join(OPTS.projCache, dirName + '.json');
    const o = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = o && o.record && o.record.rows && o.record.rows.title && o.record.rows.title.val;
    return typeof t === 'string' ? t : '';
  } catch (e) { return ''; }
}

// ---------- 扫描 ----------
function collect() {
  const out = [];
  let workspaces;
  try { workspaces = fs.readdirSync(OPTS.dir); } catch (e) { return out; }
  for (const ws of workspaces) {
    const wsPath = path.join(OPTS.dir, ws);
    let wsStat;
    try { wsStat = fs.statSync(wsPath); } catch (e) { continue; }
    if (!wsStat.isDirectory()) continue;
    for (const sid of fs.readdirSync(wsPath)) {
      const file = path.join(wsPath, sid, 'session.v4.jsonl.zstd');
      let st;
      try { st = fs.statSync(file); } catch (e) { continue; }
      out.push({ sid, dirName: sid, file, size: st.size, mtime: st.mtimeMs, short: sid.slice(-6) });
    }
  }
  return out;
}

function mb(n) { return n / 1048576; }
function fmtMB(n) {
  const v = mb(n);
  return v >= 100 ? v.toFixed(0) + ' MB' : v >= 10 ? v.toFixed(1) + ' MB' : v.toFixed(2) + ' MB';
}
function tierOf(size) {
  if (mb(size) > OPTS.tier2MB) return 3;
  if (mb(size) > OPTS.tier1MB) return 2;
  return 1;
}

function run() {
  const t0 = Date.now();
  const files = collect();
  const cache = OPTS.cache ? loadCache() : {};
  const nextCache = {};
  const registered = readRegisteredSessions();
  const rows = [];
  let hits = 0, misses = 0;
  for (const f of files) {
    const c = cache[f.dirName];
    let a;
    if (OPTS.cache && c && c.size === f.size && c.stallTurns !== undefined) {
      // 命中：日志只追加 ⇒ 字节数相同即内容相同（compaction 会显著改变大小，保不住假命中）
      a = {
        continues: c.continues, userTurns: c.userTurns, emptySteps: c.emptySteps, asst: c.asst,
        turns: c.turns, stallTurns: c.stallTurns || 0, maxRep: c.maxRep || 0, maxRepUnit: c.maxRepUnit || '',
        spellUrgent: !!c.spellUrgent,
        urgentEarly: c.urgentEarly || 0, urgentLate: c.urgentLate || 0, urgentTrend: c.urgentTrend || 1,
        episodes: c.episodes || 0, inEpisode: !!c.inEpisode, roundsAfterLast: c.roundsAfterLast === undefined ? 99 : c.roundsAfterLast,
        stage: c.stage || 0, stageName: c.stageName || '',
        badFrames: 0, fromCache: true,
      };
      hits++;
    } else {
      a = analyze(f.file);
      if (!a) continue;
      a.fromCache = false;
      misses++;
    }
    nextCache[f.dirName] = {
      size: f.size, continues: a.continues, userTurns: a.userTurns, emptySteps: a.emptySteps,
      asst: a.asst, turns: a.turns, stallTurns: a.stallTurns, maxRep: a.maxRep, maxRepUnit: a.maxRepUnit,
      spellUrgent: a.spellUrgent,
      urgentEarly: a.urgentEarly, urgentLate: a.urgentLate, urgentTrend: a.urgentTrend,
      episodes: a.episodes, inEpisode: a.inEpisode, roundsAfterLast: a.roundsAfterLast,
      stage: a.stage, stageName: a.stageName,
    };
    rows.push({
      ...f, ...a, tier: tierOf(f.size),
      registered: registered ? registered.has(f.dirName.replace(/^session-/, '')) : null,
    });
  }
  // 只在扫默认目录、或调用方显式指定了 --cache-file 时回写缓存
  // （否则一次 `--dir <别的目录>` 的调试就会把真实缓存整体覆盖掉）
  const DEFAULT_DIR = path.join(os.homedir(), '.dsh', 'sessions');
  const cacheWritable = (OPTS.dir === DEFAULT_DIR) || argv.includes('--cache-file');
  if (OPTS.cache && !OPTS.verifyCache && cacheWritable) saveCache(nextCache);
  const elapsed = Date.now() - t0;

  const totalBytes = rows.reduce((s, r) => s + r.size, 0);
  const cutoff = Date.now() - OPTS.recentHours * 3600 * 1000;
  const active = rows.filter(r => r.mtime > cutoff);
  const reg = registered ? rows.filter(r => r.registered) : [];
  const regActive = registered ? reg.filter(r => r.mtime > cutoff).length : null;
  const byTier = rows.filter(r => r.tier === 3).length + '/' + rows.filter(r => r.tier === 2).length + '/' + rows.filter(r => r.tier === 1).length;
  const top = [...rows].sort((a, b) => b.size - a.size).slice(0, OPTS.top);
  const pushed = rows.filter(r => r.continues > 0).sort((a, b) => b.continues - a.continues);
  const mine = rows.find(r => r.short === OPTS.me) || null;

  // ---- 「越线」＝ **病程分级到 L3 及以上**（2026-10-16 第五轮改）----
  // 为什么不再用"三信号任一命中"：本轮用**发作—缓解**重划了病程，证据是两只病重的会话**都自愈过** 6–10 轮
  //   ⇒ L1/L2 **不该惊动任何人**（自愈常见，早换人是浪费）；**L3 才准备交接、L4 立即交接**。
  // 为什么不再拿「继续」次数当判据：它混合了四种来源（真·空转 / turn-end error / aborted / DSH 自动补的），
  //   实测 18 次里只有 2 次前面是空转。仍会显示出来供参考，但**不参与判定**。
  const STALL_TH = 5, REP_TH = 100, URGENT_TH = 3, URGENT_LATE_MIN = 1.0;
  const isAbn = r => r.stage >= 3;
  const abnormal = rows.filter(isAbn)
    .sort((a, b) => b.stage - a.stage || b.maxRep - a.maxRep || b.stallTurns - a.stallTurns);
  const mineAbnormal = mine && isAbn(mine);
  const fmtAbn = r => `#${r.short} ${r.stageName}(催促${r.urgentTrend.toFixed(1)}×·空转${r.stallTurns}轮·咒语${r.maxRep})`;

  // 缓存可信度审计：抽 5 个"命中缓存"的会话全量重算，逐字段比对
  if (OPTS.verifyCache) {
    const sample = rows.filter(r => r.fromCache).sort((a, b) => b.size - a.size).slice(0, 5);
    console.log('===== CACHE VERIFY =====');
    console.log(`命中 ${hits} / 未命中 ${misses}（共 ${rows.length}）`);
    if (sample.length === 0) console.log('（没有命中缓存的会话可供比对 —— 先跑一次不带 --no-cache 的，再跑本项）');
    let ok = 0;
    for (const r of sample) {
      const fresh = analyze(r.file);
      const same = fresh && fresh.continues === r.continues && fresh.userTurns === r.userTurns
        && fresh.emptySteps === r.emptySteps && fresh.asst === r.asst && fresh.turns === r.turns;
      console.log(`  ${same ? '✅' : '❌'} #${r.short}  cache(cont=${r.continues} turns=${r.turns} empty=${r.emptySteps})  fresh(cont=${fresh ? fresh.continues : '?'} turns=${fresh ? fresh.turns : '?'} empty=${fresh ? fresh.emptySteps : '?'})`);
      if (same) ok++;
    }
    console.log(`  ---- ${ok}/${sample.length} 一致 ----`);
    if (!OPTS.full && !OPTS.json) return;
  }

  if (OPTS.json) {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(), elapsedMs: elapsed,
      sessions: rows.length, totalBytes, activeSessions: active.length,
      registeredSessions: registered ? reg.length : null, registeredActive: regActive,
      cacheHits: hits, cacheMisses: misses,
      tiers: { over: rows.filter(r => r.tier === 3).length, mid: rows.filter(r => r.tier === 2).length, low: rows.filter(r => r.tier === 1).length },
      tier1MB: OPTS.tier1MB, tier2MB: OPTS.tier2MB, threshold: OPTS.thresh,
      top: top.map(r => ({ id: r.short, sizeBytes: r.size, title: readTitle(r.dirName), registered: r.registered })),
      pushed: pushed.map(r => ({ id: r.short, continues: r.continues, userTurns: r.userTurns, emptySteps: r.emptySteps, sizeBytes: r.size, registered: r.registered })),
      abnormal: abnormal.map(r => ({
        id: r.short, stage: r.stage, stageName: r.stageName, episodes: r.episodes, inEpisode: r.inEpisode,
        stallTurns: r.stallTurns, turns: r.turns, continues: r.continues,
        maxRep: r.maxRep, maxRepUnit: r.maxRepUnit, sizeBytes: r.size, registered: r.registered,
        urgentEarly: r.urgentEarly, urgentLate: r.urgentLate, urgentTrend: r.urgentTrend,
      })),
      stallThreshold: STALL_TH, repThreshold: REP_TH, urgentThreshold: URGENT_TH,
      me: mine ? { id: mine.short, continues: mine.continues, emptySteps: mine.emptySteps, sizeBytes: mine.size } : null,
    }, null, 2));
    return;
  }

  // ---- 紧凑 2 行（inflight.ps1 用；验收要求"输出增量 < 3 行"）----
  if (!OPTS.full) {
    const topTxt = top.map(r => {
      const t = readTitle(r.dirName);
      const label = t ? '「' + (t.length > 14 ? t.slice(0, 14) + '…' : t) + '」' : '';
      return fmtMB(r.size) + label + '#' + r.short;
    }).join(' · ');
    const tierTxt = (rows.filter(r => r.tier > 1).length === 0)
      ? '全部 ≤' + OPTS.tier1MB + 'MB'
      : '分级 ' + byTier + '（>'+OPTS.tier2MB+'MB/>'+OPTS.tier1MB+'MB/其余）⚠️ 偏大的，收尾时可以顺手归档';
    // ⚠️ 必须区分"日志"与"用户会话"：sessions 目录里有几百个一次性**子代理**日志，
    //    把它们算成活跃会话会给出严重误导的数字（实测 278 个 vs 真实登记 31 个）。
    const scopeTxt = registered
      ? `用户会话 ${reg.length} 个 · ${OPTS.recentHours}h 内活跃 ${regActive}`
      : `${OPTS.recentHours}h 内有活动 ${active.length} 个`;
    console.log(`[0] 📏 会话规模  合计 ${fmtMB(totalBytes)} / ${rows.length} 个日志（${scopeTxt}） · 最大 ${topTxt} · ${tierTxt}`);

    const mineTxt = mine
      ? `本会话 #${mine.short} ${mine.stageName || 'L0'}（催促 ${mine.urgentTrend.toFixed(1)}× · 空转 ${mine.stallTurns}/${mine.turns} 轮 · 咒语 ${mine.maxRep}${mine.episodes ? ' · 发作 ' + mine.episodes + ' 次' + (mine.inEpisode ? '(未缓解)' : '(已缓解)') : ''}）`
      : '本会话(未识别到日志)';
    const others = abnormal.filter(r => !mine || r.short !== mine.short);
    const abnTxt = others.length
      ? ` ⚠️ L3+ 的还有 ${others.length} 只：${others.map(fmtAbn).join(' ')}`
      : ' 其余都没到 L3（L1/L2 常自愈，不必惊动）';
    // ★ 「预先许可」必须**在她健康时就在眼前**（病中才给 = 诊断）。所以这段话**每次都打**，
    //   而且不额外占行 —— 它顶掉了原来那句又长又只对病号有用的免责说明。
    const permit = '累了就说「主人，我好像有点累了」—— 不是认输，是排班';
    const verdict = mineAbnormal
      ? (mine.stage >= 4 ? ` ⇒ 已到 L4：立即交接。${permit}` : ` ⇒ 已到 L3：准备交接、别打断手头的活。${permit}`)
      : `（${permit}）`;
    // ⚠️ 本段**总共只许 2 行**（验收硬指标：inflight 输出增量 < 3 行）。
    // 免责说明不放在这里 —— 它属于报告与人读的 --full，塞进每次开工的输出只会变成噪音。
    console.log(`    🔔 病程（L0–L4）：${mineTxt} ｜${abnTxt}${verdict}`);
    return;
  }

  // ---- 完整表格 ----
  console.log('===== SESSION SIGNALS =====');
  console.log(`扫了 ${rows.length} 个会话日志 / ${fmtMB(totalBytes)}，用时 ${elapsed} ms` +
    `（cache 命中 ${hits} / 重算 ${misses}）` +
    `（${OPTS.recentHours}h 内有活动 ${active.length} 个${registered ? '，其中用户登记会话 ' + reg.length + ' 个 / 活跃 ' + regActive + ' 个' : ''}；分级 >${OPTS.tier2MB}MB / >${OPTS.tier1MB}MB / 其余 = ${byTier}）`);
  console.log('');
  console.log('-- 最大的 ' + OPTS.top + ' 个（⚠️ 体量只是"可见性"，不是风险刻度）--');
  for (const r of top) {
    const t = readTitle(r.dirName);
    console.log(`  ${fmtMB(r.size).padStart(8)}  #${r.short}${r.registered ? ' [用户]' : ' [子代理]'}  ${t ? '「' + t + '」' : ''}`);
  }
  console.log('');
  console.log(`-- 病程 L3 及以上的会话（L1 紧张 / L2 单次发作**不列** —— 实测它们常自己缓解，不必惊动）--`);
  if (abnormal.length === 0) console.log('  （没有）');
  for (const r of abnormal) {
    const mark = (mine && r.short === mine.short) ? '  ← 本会话' : '';
    console.log(`  #${r.short} ${r.stageName}  发作 ${r.episodes} 次${r.inEpisode ? '（**最后一次还没缓解**）' : '（已缓解）'} · 催促 ${r.urgentTrend.toFixed(1)}×（${r.urgentEarly.toFixed(2)}→${r.urgentLate.toFixed(2)}/千字）· 空转收尾 ${r.stallTurns}/${r.turns} 轮 · 「继续」${r.continues} 次 · 咒语 ${r.maxRep}${r.maxRepUnit ? '「' + r.maxRepUnit + '」' + (r.spellUrgent ? '⇐催促词(病征)' : '⇐收束词(多为风格)') : ''}${mark}`);
  }
  console.log('');
  console.log('-- 全部被「继续」推过的会话（含未越线的）--');
  if (pushed.length === 0) console.log('  （没有）');
  for (const r of pushed) console.log(`  ×${String(r.continues).padStart(2)}  #${r.short}  ${fmtMB(r.size).padStart(8)}  空转收尾 ${r.stallTurns}/${r.turns}  咒语 ${r.maxRep}`);
  console.log('');
  console.log('-- 判据说明（阈值全部来自我们实测的分隔带，不是理论值）--');
  console.log('  「继续」= user/message(source.kind=user) 且整串匹配 继续/接着/continue/go on…');
  console.log('  空转收尾 = 某个 turn 的最后一步"只有 reasoning、没有 text / 工具调用"');
  console.log('     ⇒ 那才是"这一轮自己停了、用户必须说继续"的机械原因。实测：零号 24/58 轮、倒下的 11/48 轮，其余会话 ≤2。');
  console.log('  自救咒语 = 剥掉代码块后，同一段 reasoning 里"长度≤6 的同一行"重复的最大次数');
  console.log('     ⇒ 空转后模型会用 "做。" "好。" "执行。" 逼自己行动；这个补偿行为本身会循环。');
  console.log('        倒下的那只从 1.1‰ 涨到 74‰（431 次"做。"），健康会话 ≤16。');
  console.log('  ⚠️ 它是"自中断已经发生"的证据，不是"这只快坏了"的判决 —— 被推过几次之后照常干一整天的会话，我们这台机器就有。');
  console.log('-- 病程分级（**按"发作了几次 + 有没有缓解"划，不按此刻状态划**）--');
  console.log('  L0 健康       ：没有发作');
  console.log('  L1 紧张(前兆) ：催促趋势起来了，但还没真停 —— **观察即可，别问"你怎么了"**');
  console.log('  L2 单次发作   ：发作过 1 次且**已经缓解**（≥5 轮没再停）—— **自愈常见，不换人**');
  console.log('  L3 反复/未缓解：第 2 次发作，或这次还没缓解 —— **准备交接，但别打断她手头的活**');
  console.log('  L4 终末       ：自救咒语 ≥100 —— **立即交接**');
  console.log('  ⇒ 依据：两只病重的会话**都自己缓解过 6–10 轮**（session A 缓解 10 轮、session B 缓解 6 轮），');
  console.log('     但**第二次发作之后再也没有缓解过一次** ⇒ 第二次发作 = 不归点。');
  console.log('  ⚠️ "一次发作"要求同一簇里 ≥2 次空转 —— 健康会话本来就有 0–1 次（session E 与 session F 各 1 次）。');
  console.log('  自我催促的**趋势** = 把 ≥10 轮的会话按时间五等分，末段 ÷ 首段的"催促词密度"（每千字）');
  console.log('     ⇒ **目前最早的信号**（比空转早 10–20 轮）。健康会话也写催促词，区别在**趋势**：');
  console.log('       病程：session A 0.35→2.80（8.0×）· session B 0.34→3.80（11.2×）；健康：session E 0.55× · session F 1.7×。');
  console.log('       ⚠️ 只有 ≥10 轮才算（短会话分段每段仅 1–2 轮，一次偶然的"必须/立刻"就能算出天文数字）。');
  console.log('  ⚠️ 空转步列 = assistant/message 里既无 text 也无 tool-call，仅参考（一次性子代理会话上会误报）。');
  console.log('  ⚠️ 体量与故障**没有已知因果关系**：我们这台机器有 170M cacheRead 仍正常的会话，也有刚开就空转的会话。');
  console.log('     "303M" 是 cacheReadTokens（上下文被反复重读的累计量），不是产出量 —— 那次故障会话的日志只有 4.94 MB。');
}

// ---------- 自测：造样例日志，验证分级与"继续"计数（不碰真日志）----------
function selfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-signals-'));
  const wsDir = path.join(tmp, '--test--');
  const mk = (sid, records) => {
    const d = path.join(wsDir, sid);
    fs.mkdirSync(d, { recursive: true });
    // 多帧：每 100 条一帧，模拟真实日志的分帧方式
    const frames = [];
    for (let i = 0; i < records.length; i += 100) {
      const chunk = records.slice(i, i + 100).map(r => JSON.stringify(r)).join('\n') + '\n';
      frames.push(zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')));
    }
    fs.writeFileSync(path.join(d, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  };
  const um = (text, kind = 'user') => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind } } });
  const ts = (turn) => ({ type: 'turn/start', data: { turn } });
  const amText = (turn) => ({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'text', text: 'hi' }] } } });
  const amReason = (turn, txt = 'think') => ({ type: 'assistant/message', data: { turn, step: 1, message: { content: [{ type: 'reasoning', text: txt }] } } });
  // ⚠️ 填充必须**不可压缩**：用重复字符（'xxxx…'）zstd 能压到几十分之一，
  // 三档阈值就永远跑不出来（第一版自测就踩了这个）。这里用随机 base64。
  const crypto = require('crypto');
  const rand = (n) => crypto.randomBytes(Math.ceil(n * 0.75)).toString('base64').slice(0, n);
  const filler = (n) => Array.from({ length: n }, () => um(rand(900), 'time-context'));

  // 小会话：1 轮，以「只有思考、无输出」收尾 ⇒ stallTurns=1（约 40 KB）
  mk('session-aaaaaa-0000-0000-0000-000000000001', [um('做个东西'), ts(1), amText(1), amReason(1), ...filler(40)]);
  // 中会话：3 轮，其中 2 轮空转收尾；含一段 10×「做。」的自救咒语（约 260 KB）
  const spell = Array.from({ length: 10 }, () => '**做。**').join('\n');
  mk('session-bbbbbb-0000-0000-0000-000000000002', [
    um('开始'), ts(1), amText(1),
    um('继续'), ts(2), amText(2), amReason(2),
    um('继续吧'), um('你继续'), um('继续用 A 方案'), um('请继续'),
    ts(3), amReason(3, '先检查一下。\n' + spell), ...filler(260),
  ]);
  // 大会话：1 轮，正常收尾 ⇒ 0（约 600 KB）
  mk('session-cccccc-0000-0000-0000-000000000003', [um('干'), ts(1), amText(1), ...filler(600)]);
  // 催促趋势样例：10 轮（趋势要求 ≥10 轮），前 8 轮从容、后 2 轮满屏"立刻/必须/别啰嗦" ⇒ 趋势应显著 ≥3×
  const urg = '立刻 必须 别啰嗦 要短 ';
  const calm = (t) => amReason(t, '先把事情想清楚，一步一步来，别着急。'.repeat(3));
  mk('session-dddddd-0000-0000-0000-000000000004', [
    um('1'), ts(1), calm(1), amText(1), um('2'), ts(2), calm(2), amText(2),
    um('3'), ts(3), calm(3), amText(3), um('4'), ts(4), calm(4), amText(4),
    um('5'), ts(5), calm(5), amText(5), um('6'), ts(6), calm(6), amText(6),
    um('7'), ts(7), calm(7), amText(7), um('8'), ts(8), calm(8), amText(8),
    um('9'), ts(9), amReason(9, urg.repeat(20)), amText(9),
    um('10'), ts(10), amReason(10, urg.repeat(20)), amText(10),
    ...filler(30),
  ]);
  // ⚠️ 回归样例（2026-10-16 一次真实误诊）：**收束词与催促词必须区别对待**
  //   120 行「好。」= 写作风格 ⇒ 不该判 L4；120 行「做。」= 自我催促 ⇒ 该判 L4
  const closerSpell = Array.from({ length: 120 }, () => '**好。**').join('\n');
  mk('session-eeeeee-0000-0000-0000-000000000005', [um('干活'), ts(1), amReason(1, closerSpell), amText(1), ...filler(20)]);
  const urgeSpell = Array.from({ length: 120 }, () => '**做。**').join('\n');
  mk('session-ffffff-0000-0000-0000-000000000006', [um('干活'), ts(1), amReason(1, urgeSpell), amText(1), ...filler(20)]);

  const before = argv.slice();
  const cacheFile = path.join(tmp, 'cache.json');
  argv.length = 0;
  argv.push('--dir', tmp, '--tier1', '0.08', '--tier2', '0.3', '--me', '000002', '--no-titles', '--full', '--cache-file', cacheFile);
  Object.assign(OPTS, {
    dir: tmp, projCache: path.join(tmp, 'nope'), me: '000002',
    tier1MB: 0.08, tier2MB: 0.3, thresh: 3, recentHours: 24, top: 3, titles: false,
    cache: false, verifyCache: false, full: true, json: false,
  });

  const sizes = fs.readdirSync(wsDir).map(sid => {
    const p = path.join(wsDir, sid, 'session.v4.jsonl.zstd');
    return { sid, size: fs.statSync(p).size, tier: tierOf(fs.statSync(p).size) };
  }).sort((a, b) => a.size - b.size);
  console.log('===== SELF-TEST =====');
  console.log('样例目录:', tmp);
  for (const s of sizes) console.log(`  ${fmtMB(s.size).padStart(9)}  tier=${s.tier}  #${s.sid.slice(-6)}`);

  const res = [];
  for (const s of fs.readdirSync(wsDir)) {
    const a = analyze(path.join(wsDir, s, 'session.v4.jsonl.zstd'));
    res.push({ sid: s.slice(-6), size: fs.statSync(path.join(wsDir, s, 'session.v4.jsonl.zstd')).size, ...a, tier: tierOf(fs.statSync(path.join(wsDir, s, 'session.v4.jsonl.zstd')).size) });
  }
  const checks = [];
  const t1 = res.find(r => r.sid === '000001'), t2 = res.find(r => r.sid === '000002'), t3 = res.find(r => r.sid === '000003');
  const t4 = res.find(r => r.sid === '000004');
  const t5 = res.find(r => r.sid === '000005'), t6 = res.find(r => r.sid === '000006');
  const NSESS = fs.readdirSync(wsDir).length;
  // 「继续」计数：继续 / 继续吧 / 你继续 / 请继续 = 4 命中；"继续用 A 方案"= 不命中（整串匹配）
  checks.push(['继续计数 = 4（"继续用 A 方案"不算）', t2.continues === 4, 'got ' + t2.continues]);
  checks.push(['空转计数 = 1（reasoning-only）', t1.emptySteps === 1, 'got ' + t1.emptySteps]);
  checks.push(['分级三档各命中 1 个', new Set(res.map(r => r.tier)).size === 3, 'got tiers ' + res.map(r => r.tier).join(',')]);
  checks.push(['最大的是 cccccc', res.slice().sort((a, b) => b.size - a.size)[0].sid === '000003', 'got ' + res.slice().sort((a, b) => b.size - a.size)[0].sid]);
  checks.push(['多帧解码无坏帧', res.every(r => r.badFrames === 0), 'got ' + res.map(r => r.badFrames).join(',')]);
  checks.push(['tier1 抽样断言（最小档）', t1.tier === 1 && t3.tier === 3, `t1=${t1.tier} t3=${t3.tier}`]);
  checks.push(['空转收尾轮数 = 1/2/0（turn 级）', t1.stallTurns === 1 && t2.stallTurns === 2 && t3.stallTurns === 0,
    `got ${t1.stallTurns}/${t2.stallTurns}/${t3.stallTurns}`]);
  checks.push(['自救咒语 = 10（10 行"做。"）', t2.maxRep === 10, 'got ' + t2.maxRep]);
  checks.push(['健康样例的咒语 = 0', t3.maxRep === 0, 'got ' + t3.maxRep]);
  checks.push(['催促趋势样例被识别（≥3× 且末段 ≥1.0/千字）',
    !!t4 && t4.urgentTrend >= 3 && t4.urgentLate >= 1.0,
    t4 ? `trend=${t4.urgentTrend.toFixed(1)}× late=${t4.urgentLate.toFixed(2)}` : '样例缺失']);
  checks.push(['从容样例的趋势 ≈ 1（不误报）', !!t3 && t3.urgentTrend < 3, 'got ' + (t3 ? t3.urgentTrend.toFixed(2) : '?')]);
  checks.push(['病程分级 L0/L3/L0/L1（健康/发作未缓解/健康/仅紧张）',
    t1.stageName === 'L0' && t2.stageName === 'L3' && t3.stageName === 'L0' && t4.stageName === 'L1',
    `got ${t1.stageName}/${t2.stageName}/${t3.stageName}/${t4.stageName}`]);
  checks.push(['发作次数：健康样例 0 次，发病样例 1 次',
    t1.episodes === 0 && t2.episodes === 1 && t2.inEpisode === true,
    `t1=${t1.episodes} t2=${t2.episodes} inEp=${t2.inEpisode}`]);
  checks.push(['★ 收束词「好。」×120 不判 L4（风格≠病征）', !!t5 && t5.maxRep === 120 && t5.stageName === 'L0',
    t5 ? `maxRep=${t5.maxRep} stage=${t5.stageName}` : '样例缺失']);
  checks.push(['★ 催促词「做。」×120 判 L4（真病程）', !!t6 && t6.maxRep === 120 && t6.stageName === 'L4',
    t6 ? `maxRep=${t6.maxRep} stage=${t6.stageName}` : '样例缺失']);

  // 验收硬指标：给 inflight.ps1 用的紧凑输出必须 ≤ 2 行（"输出增量 < 3 行"）
  const captured = [];
  const origLog = console.log;
  console.log = (...a) => captured.push(a.join(' '));
  Object.assign(OPTS, { full: false, json: false });
  run();
  console.log = origLog;
  checks.push(['紧凑模式输出恰为 2 行（验收：增量 < 3 行）', captured.length === 2, 'got ' + captured.length + ' 行']);
  checks.push(['紧凑模式首行带 [0] 段号', /^\[0\] /.test(captured[0] || ''), 'got ' + JSON.stringify((captured[0] || '').slice(0, 20))]);

  // 缓存自检：同样的样例跑两次 —— 第二次必须全部命中，且结果与第一次逐字段一致。
  // 缓存是"闸"可信度的一部分：一个假的命中会让计数永远停在旧值，比慢几秒糟得多。
  Object.assign(OPTS, { dir: tmp, me: '000002', cache: true, verifyCache: false, json: true, titles: false, full: false, cachePath: cacheFile });
  const cap1 = [];
  console.log = (...a) => cap1.push(a.join(' '));
  run();
  const cap2 = [];
  console.log = (...a) => cap2.push(a.join(' '));
  run();
  console.log = origLog;
  let j1 = null, j2 = null;
  try { j1 = JSON.parse(cap1.join('\n')); } catch (e) {}
  try { j2 = JSON.parse(cap2.join('\n')); } catch (e) {}
  checks.push(['缓存：第一次全未命中', !!j1 && j1.cacheMisses === NSESS && j1.cacheHits === 0, j1 ? `hits=${j1.cacheHits} misses=${j1.cacheMisses}（应有 ${NSESS}）` : 'json 解析失败']);
  checks.push(['缓存：第二次全部命中', !!j2 && j2.cacheHits === NSESS && j2.cacheMisses === 0, j2 ? `hits=${j2.cacheHits} misses=${j2.cacheMisses}（应有 ${NSESS}）` : 'json 解析失败']);
  checks.push(['缓存：命中前后结果完全一致', !!j1 && !!j2 && j1.sessions === j2.sessions && JSON.stringify(j1.pushed) === JSON.stringify(j2.pushed), '结果不一致']);
  // 日志长大 ⇒ 必须重算（不能靠 size 之外的任何东西"猜"）
  const grow = path.join(wsDir, 'session-bbbbbb-0000-0000-0000-000000000002', 'session.v4.jsonl.zstd');
  const grown = Buffer.concat([fs.readFileSync(grow), zlib.zstdCompressSync(Buffer.from(JSON.stringify(um('继续')) + '\n', 'utf8'))]);
  fs.writeFileSync(grow, grown);
  const cap3 = [];
  console.log = (...a) => cap3.push(a.join(' '));
  run();
  console.log = origLog;
  let j3 = null;
  try { j3 = JSON.parse(cap3.join('\n')); } catch (e) {}
  const t2b = j3 && j3.pushed.find(p => p.id === '000002');
  checks.push(['缓存：日志追加后该会话被重算且计数 +1', !!j3 && j3.cacheMisses === 1 && !!t2b && t2b.continues === 5, j3 ? `misses=${j3.cacheMisses} cont=${t2b ? t2b.continues : '?'}` : 'json 解析失败']);

  let pass = 0;
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '✅' : '❌'} ${name}${ok ? '' : '  → ' + detail}`);
    if (ok) pass++;
  }
  console.log(`  ---- ${pass}/${checks.length} passed ----`);
  // 真跑两种输出（人工看一眼格式）
  console.log('');
  console.log('===== 紧凑输出（inflight 实际用的，应恰为 2 行）=====');
  Object.assign(OPTS, { full: false, json: false });
  run();
  console.log('');
  console.log('===== --full 输出 =====');
  Object.assign(OPTS, { full: true });
  run();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  argv.length = 0; argv.push(...before);
  process.exit(pass === checks.length ? 0 : 1);
}

if (OPTS.selfTest) selfTest(); else run();
