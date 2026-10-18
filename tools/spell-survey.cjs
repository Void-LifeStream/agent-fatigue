#!/usr/bin/env node
/**
 * spell-survey.cjs — 全库统计「自救咒语」（按 FINDINGS.md §1 的原始定义）
 *
 * 定义（严格照报告）：
 *   self-prompt loops = 同一短行（≤6 字符）在一个 reasoning block 内重复的**最大次数**，
 *   统计前**剥离 fenced code blocks**（否则 JSON 的 `}` 会算成"重复行"）。
 *
 * 用法：
 *   node spell-survey.cjs [--limit N] [--min-bytes B] [--out 文件] [--workers 4]
 *
 * 输出：每行一个会话的统计（TSV），另打印分布摘要。
 * 设计为可中断：结果按会话逐行 append，随时可以停。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const LIMIT = parseInt(arg('--limit', '999999'), 10);
const MIN_BYTES = parseInt(arg('--min-bytes', '20000'), 10);
const OUT = arg('--out', path.join(os.homedir(), '.dsh', 'inflight', 'spell-survey.tsv'));

// ── 解码：多帧 zstd ──
function decodeAll(buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const cuts = [];
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) cuts.push(i);
  if (!cuts.length) cuts.push(0);
  cuts.push(buf.length);
  const parts = [];
  for (let k = 0; k < cuts.length - 1; k++) {
    const fr = buf.subarray(cuts[k], cuts[k + 1]);
    if (!fr.length) continue;
    for (let j = fr.length; j > 4; j -= 1) {
      try { parts.push(zlib.zstdDecompressSync(fr.subarray(0, j))); break; } catch {}
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

// ── 剥 fenced code blocks（报告明确要求）──
const stripFences = (t) => t.replace(/```[\s\S]*?```/g, '').replace(/~~~[\s\S]*?~~~/g, '');

// ── 单个 reasoning block 内，同一短行（≤6 字符）的最大重复次数 ──
function maxRepeatInBlock(text) {
  const clean = stripFences(text);
  const counts = new Map();
  for (let raw of clean.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.length > 6) continue;                 // 报告：≤6 chars
    if (/^[|>#*_\-\s]+$/.test(line)) continue;      // 纯装饰行不算
    counts.set(line, (counts.get(line) || 0) + 1);
  }
  let best = 0, which = '';
  for (const [k, v] of counts) if (v > best) { best = v; which = k; }
  return { best, which };
}

// ── 枚举所有会话日志 ──
function enumerateLogs() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const f = path.join(p, 'session.v4.jsonl.zstd');
        if (fs.existsSync(f)) {
          const st = fs.statSync(f);
          if (st.size >= MIN_BYTES) out.push({ dir: e.name, file: f, bytes: st.size, mtime: st.mtimeMs });
        } else stack.push(p);
      }
    }
  }
  out.sort((a, b) => b.bytes - a.bytes);
  return out;
}

// ── 主流程 ──
const logs = enumerateLogs();
console.log('  扫描到会话日志（>= ' + MIN_BYTES + ' B）: ' + logs.length + ' 个');
const todo = logs.slice(0, LIMIT);
console.log('  本次处理: ' + todo.length + ' 个   输出: ' + OUT);

const hdr = ['session', 'bytes_kb', 'decode_chars', 'max_repeat', 'repeat_token', 'blocks', 'is_subagent'];
if (!fs.existsSync(OUT)) fs.writeFileSync(OUT, hdr.join('\t') + '\n', 'utf8');

const t0 = Date.now();
let done = 0;
for (const item of todo) {
  let rec;
  try {
    const text = decodeAll(fs.readFileSync(item.file));
    let maxRep = 0, token = '', blocks = 0;
    for (const ln of text.split('\n')) {
      if (!ln.startsWith('{')) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.type !== 'assistant/message' || !o.data || !o.data.message) continue;
      for (const c of (o.data.message.content || [])) {
        if (!c || c.type !== 'reasoning' || !c.text) continue;
        blocks++;
        const { best, which } = maxRepeatInBlock(c.text);
        if (best > maxRep) { maxRep = best; token = which; }
      }
    }
    const short = (item.dir.match(/[0-9a-f]{6}$/) || [item.dir.slice(-6)])[0];
    const isSub = item.dir.startsWith('session-') ? '0' : '1';
    rec = [short, (item.bytes / 1024).toFixed(0), text.length, maxRep, token || '-', blocks, isSub].join('\t');
  } catch (e) {
    rec = [(item.dir.slice(-6)), (item.bytes / 1024).toFixed(0), 'ERR', 'ERR', e.message.slice(0, 30), '0', '?1'].join('\t');
  }
  fs.appendFileSync(OUT, rec + '\n', 'utf8');
  done++;
  if (done % 10 === 0 || done === todo.length) {
    const el = ((Date.now() - t0) / 1000).toFixed(0);
    console.log('    进度 ' + done + '/' + todo.length + '  用时 ' + el + 's  均 ' + (el / done * 1000).toFixed(0) + 'ms/个');
  }
}
console.log('  完成。结果: ' + OUT);
