#!/usr/bin/env node
/**
 * block-repeats.cjs — 找「最长重复块」（只读、按需跑，**不进开工流程**）
 *
 * ── 为什么单独一个脚本，不并进 session-signals.cjs ──────────────────────
 *   `session-signals.cjs` 每次开工都跑（~80 ms，靠缓存）。算 maxRepeat 要解压全部日志，
 *   会让**全部缓存失效**（本机 3.7 GB 日志）。⇒ 拆开，**别拖慢全机的开工检查**。
 *
 * ── 用途 ────────────────────────────────────────────────────────────────
 *   给「刹车失败 / runaway repetition」一类现象做**可见性**：
 *   现有判据只数「以只有 reasoning 结束的 turn」，**看不见**「一个块内部重复了 2000 次」。
 *   （背景：`FINDINGS §11`；社区案例 `deepseek-harness#6711` 736 KB / 48,898 次）
 *
 * ⚠️ **只显示、不判级**：重复多 ≠ 崩。
 *   `#c3ff05` T13：1,638 次「好。」但**有 tool-call**（正常）
 *   `#4cc913` T87：2,353 次「好。」且 **0 输出**（异常）
 *   ⇒ 判别标准是**填充密度 + 有没有产出**，不是重复次数本身（见 `FINDINGS §7.1 / §11`）。
 *
 * ── 口径（与 session-signals.cjs 的「自救咒语」一致）────────────────────
 *   剥掉代码块后，同一段 reasoning 里「长度 ≤ 6 的同一行」重复的最大次数。
 *
 * ── 用法 ────────────────────────────────────────────────────────────────
 *   node block-repeats.cjs                        # 全库（~5 秒），reasoning > 3000 字符，TOP 10
 *   node block-repeats.cjs --recent               # **只看 24h 内活跃会话**（秒级；"随手看一眼"用这个）
 *   node block-repeats.cjs --min 8000 --top 5
 *   node block-repeats.cjs <session.v4.jsonl.zstd>    # 只扫一个会话
 *
 * 退出码：0 = 正常；1 = 参数错误。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_SHORT_LINE = 6;

function parseArgs(argv) {
  const out = { min: 3000, top: 10, file: null, recent: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--min') out.min = Number(argv[++i]) || 3000;
    else if (a === '--top') out.top = Number(argv[++i]) || 10;
    else if (a === '--recent') out.recent = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else if (!a.startsWith('--')) out.file = a;
    else { console.error('unknown argument: ' + a); process.exit(1); }
  }
  return out;
}

/** 剥掉 ``` 围栏块（与 session-signals 同口径：不剥会把 JSON 的 } 当成咒语）。 */
function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

/** 单个 reasoning 文本 → { maxCount, maxLine }（长度 ≤6 的同一行重复的最大次数）。 */
function maxShortLineRepeat(text) {
  const lines = stripFences(text).split('\n').map((s) => s.trim()).filter(Boolean);
  let best = { maxCount: 0, maxLine: '' };
  const map = new Map();
  for (const ln of lines) {
    if (ln.length > MAX_SHORT_LINE) continue;
    const n = (map.get(ln) || 0) + 1;
    map.set(ln, n);
    if (n > best.maxCount) best = { maxCount: n, maxLine: ln };
  }
  return best;
}

/** 多帧 zstd → 每一帧解压后的文本数组。 */
function frames(buf) {
  const starts = [];
  let i = 0;
  while (true) {
    const k = buf.indexOf(ZSTD_MAGIC, i);
    if (k < 0) break;
    starts.push(k);
    i = k + 4;
  }
  const out = [];
  for (let j = 0; j < starts.length; j++) {
    const s = starts[j];
    const e = j + 1 < starts.length ? starts[j + 1] : buf.length;
    try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')); } catch { /* 坏帧跳过 */ }
  }
  return out;
}

function scanFile(file, min, rows) {
  const buf = fs.readFileSync(file);
  const short = path.basename(path.dirname(file)).replace(/^session-[0-9a-f]+-/, '').slice(-6);
  for (const frame of frames(buf)) {
    for (const ln of frame.split('\n')) {
      if (!ln.trim()) continue;
      let r;
      try { r = JSON.parse(ln); } catch { continue; }
      if (r.type !== 'assistant/message') continue;
      const bs = r.data?.message?.content || [];
      const reasoning = bs.filter((b) => b.type === 'reasoning').map((b) => b.text || '').join('\n');
      if (!reasoning || reasoning.length < min) continue;
      const rep = maxShortLineRepeat(reasoning);
      if (rep.maxCount < 50) continue;                       // 低于这个数没意义
      const hasText = bs.some((b) => b.type === 'text' && (b.text || '').trim());
      const hasTool = bs.some((b) => b.type === 'tool-call');
      rows.push({
        short,
        turn: r.data.turn,
        step: r.data.step,
        chars: reasoning.length,
        lines: stripFences(reasoning).split('\n').filter((s) => s.trim()).length,
        rep: rep.maxCount,
        word: rep.maxLine,
        hasText,
        hasTool,
      });
    }
  }
}

function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name === 'session.v4.jsonl.zstd') out.push(p);
  }
}

// ── main ────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv);
const files = [];
if (opts.file) {
  files.push(opts.file);
} else {
  walk(path.join(os.homedir(), '.dsh', 'sessions'), files);
}
if (opts.recent) {
  // 只扫 24h 内写过的日志（"随手看一眼"的快速模式；全库约 5 秒，recent 是秒级）
  const cutoff = Date.now() - 24 * 3600 * 1000;
  const kept = [];
  for (const f of files) {
    try { if (fs.statSync(f).mtimeMs >= cutoff) kept.push(f); } catch { /* skip */ }
  }
  files.length = 0;
  files.push(...kept);
}
console.error(
  `[block-repeats] 扫 ${files.length} 个日志（min reasoning=${opts.min}${opts.recent ? '，只看 24h 内活跃' : ''}）`,
);

const rows = [];
let scanned = 0;
for (const f of files) {
  try { scanFile(f, opts.min, rows); } catch { /* 跳过坏文件 */ }
  if (++scanned % 200 === 0) console.error(`  ...${scanned}/${files.length}`);
}

rows.sort((a, b) => b.rep - a.rep);
console.log(`\n=== 最长重复块 TOP ${opts.top}（只显示，不判级）===`);
console.log('⚠️ 重复多 ≠ 崩：判别看「填充密度 + 有没有产出」（FINDINGS §7.1 / §11）\n');
console.log('  rep    块大小   行数  turn/step   有文字 有工具  重复词        会话');
for (const r of rows.slice(0, opts.top)) {
  console.log(
    `  ${String(r.rep).padStart(5)}  ${String(r.chars).padStart(7)}  ${String(r.lines).padStart(5)}  ` +
      `T${String(r.turn).padStart(3)}/S${String(r.step).padStart(2)}  ` +
      `${r.hasText ? '  ✓  ' : '  ✗  '}${r.hasTool ? '  ✓  ' : '  ✗  '}  ` +
      `${JSON.stringify(r.word).padEnd(12)}  #${r.short}`,
  );
}
const zero = rows.filter((r) => !r.hasText && !r.hasTool).length;
console.log(`\n共 ${rows.length} 个「重复 ≥50 次」的块；其中 **零输出**（无文字、无工具）的：${zero} 个`);
console.log('（零输出 + 高重复 = 「刹车失败」的候选形态；对照 FINDINGS §11）');
