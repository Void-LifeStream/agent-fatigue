#!/usr/bin/env node
/**
 * two-axes-survey.cjs — 全库同时量两个轴：
 *   ① 最长重复短行（报告定义：同一 ≤6 字符行在一个 reasoning block 内的最大出现次数，剥 fenced code）
 *   ② 空转率（报告口径：turn 的末步没有 text）
 *
 * 目的：检验「重复」与「空转」是否正交（2026-10-18 本会话发现 #bf8c60 重复 15901 但空转 3.8%）
 *
 * 用法: node two-axes-survey.cjs [--min-bytes 20000] [--out 文件]
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const MIN_BYTES = parseInt(arg('--min-bytes', '20000'), 10);
const OUT = arg('--out', path.join(os.homedir(), '.dsh', 'inflight', 'two-axes-survey.tsv'));

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
const BT = String.fromCharCode(96);
const FENCE = BT + BT + BT;
function stripFences(s) {
  const out = []; let inB = false;
  for (const line of s.split('\n')) {
    if (line.trim().startsWith(FENCE)) { inB = !inB; continue; }
    if (!inB) out.push(line);
  }
  return out.join('\n');
}

function enumerateLogs() {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  const out = []; const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        const f = path.join(p, 'session.v4.jsonl.zstd');
        if (fs.existsSync(f)) {
          const st = fs.statSync(f);
          if (st.size >= MIN_BYTES) out.push({ dir: e.name, file: f, bytes: st.size });
        } else stack.push(p);
      }
    }
  }
  return out;
}

const logs = enumerateLogs();
console.log('  日志数: ' + logs.length + '   输出: ' + OUT);
const hdr = ['session', 'kb', 'turns', 'silent_turns', 'stall_rate_pct', 'max_repeat', 'repeat_token', 'is_subagent'];
fs.writeFileSync(OUT, hdr.join('\t') + '\n', 'utf8');

const t0 = Date.now();
let done = 0;
for (const item of logs) {
  let line;
  try {
    const txt = decodeAll(fs.readFileSync(item.file));
    const turns = new Map();   // turn -> { lastHasText, maxRep, token }
    for (const ln of txt.split('\n')) {
      if (!ln.startsWith('{')) continue;
      let o; try { o = JSON.parse(ln); } catch { continue; }
      if (o.type !== 'assistant/message' || !o.data || !o.data.message) continue;
      const t = o.data.turn;
      if (typeof t !== 'number') continue;
      const rec = turns.get(t) || { lastHasText: false, maxRep: 0, token: '' };
      let hasText = false;
      for (const c of (o.data.message.content || [])) {
        if (!c) continue;
        if (c.type === 'text' && c.text && c.text.trim()) hasText = true;
        if (c.type === 'reasoning' && c.text) {
          const cnt = new Map();
          for (const raw of stripFences(c.text).split('\n')) {
            const s = raw.trim();
            if (!s || s.length > 6) continue;
            if (/^[|>#*_\-\s]+$/.test(s)) continue;
            cnt.set(s, (cnt.get(s) || 0) + 1);
          }
          for (const [k, v] of cnt) if (v > rec.maxRep) { rec.maxRep = v; rec.token = k; }
        }
      }
      rec.lastHasText = hasText;   // 覆盖为最后一条
      turns.set(t, rec);
    }
    const list = [...turns.values()];
    const turnsN = list.length;
    const silent = list.filter(r => !r.lastHasText).length;
    let best = 0, tok = '';
    for (const r of list) if (r.maxRep > best) { best = r.maxRep; tok = r.token; }
    const short = (item.dir.match(/[0-9a-f]{6}$/) || [item.dir.slice(-6)])[0];
    const isSub = item.dir.startsWith('session-') ? '0' : '1';
    line = [short, (item.bytes / 1024).toFixed(0), turnsN, silent,
      turnsN ? (silent / turnsN * 100).toFixed(1) : '',
      best, tok || '-', isSub].join('\t');
  } catch (e) {
    line = [item.dir.slice(-6), (item.bytes / 1024).toFixed(0), '', '', 'ERR', '', e.message.slice(0, 25), '?1'].join('\t');
  }
  fs.appendFileSync(OUT, line + '\n', 'utf8');
  done++;
  if (done % 100 === 0 || done === logs.length) {
    console.log('    进度 ' + done + '/' + logs.length + '  ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  }
}
console.log('  完成: ' + OUT);
