#!/usr/bin/env node
/**
 * blocklen-survey.cjs — 全库统计「最长 reasoning block 的字符数」
 *
 * 为什么需要它：2026-10-18 发现 `#bf8c60` 的 15901 次「发。」全部在一个 **448,400 字符 / 95,530 行**的
 * 单个 reasoning block 里（前约 4.7 万行正常，之后崩溃进入循环）。这可能是一个比"重复次数"更好的轴。
 * 本脚本把它与「空转率」「最长重复」并列，输出 TSV。
 *
 * 用法: node blocklen-survey.cjs [--min-bytes 20000] [--out 文件]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MIN_BYTES = parseInt(arg('--min-bytes', '20000'), 10);
const OUT = arg('--out', path.join(os.homedir(), '.dsh', 'inflight', 'blocklen-survey.tsv'));

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
    for (let j = fr.length; j > 4; j -= 1) { try { parts.push(zlib.zstdDecompressSync(fr.subarray(0, j))); break; } catch {} }
  }
  return Buffer.concat(parts).toString('utf8');
}

const root = path.join(os.homedir(), '.dsh', 'sessions');
const logs = [];
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
        if (st.size >= MIN_BYTES) logs.push({ dir: e.name, file: f, bytes: st.size });
      } else stack.push(p);
    }
  }
}

console.log('  日志数: ' + logs.length + '   输出: ' + OUT);
fs.writeFileSync(OUT, ['session', 'kb', 'blocks', 'max_block_chars', 'max_block_turn', 'total_chars', 'is_subagent'].join('\t') + '\n', 'utf8');

const t0 = Date.now();
let done = 0;
for (const item of logs) {
  let line;
  try {
    const txt = decodeAll(fs.readFileSync(item.file));
    let maxLen = 0, maxTurn = '', blocks = 0, total = 0;
    for (const ln of txt.split('\n')) {
      if (!ln.startsWith('{')) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.type !== 'assistant/message' || !o.data || !o.data.message) continue;
      for (const c of (o.data.message.content || [])) {
        if (!c || c.type !== 'reasoning' || !c.text) continue;
        blocks++; total += c.text.length;
        if (c.text.length > maxLen) { maxLen = c.text.length; maxTurn = o.data.turn; }
      }
    }
    const short = (item.dir.match(/[0-9a-f]{6}$/) || [item.dir.slice(-6)])[0];
    const isSub = item.dir.startsWith('session-') ? '0' : '1';
    line = [short, (item.bytes / 1024).toFixed(0), blocks, maxLen, maxTurn, total, isSub].join('\t');
  } catch (e) {
    line = [item.dir.slice(-6), (item.bytes / 1024).toFixed(0), '', 'ERR', '', '', '?1'].join('\t');
  }
  fs.appendFileSync(OUT, line + '\n', 'utf8');
  done++;
  if (done % 100 === 0 || done === logs.length) {
    console.log('    进度 ' + done + '/' + logs.length + '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
}
console.log('  完成: ' + OUT);
