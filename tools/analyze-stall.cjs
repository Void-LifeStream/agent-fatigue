// Per-session drill-down for DSH v4 session logs (multi-frame zstd).
// Read-only. Counts steps, turn/end kinds, the largest reasoning block, stall-shaped
// steps, and prints a per-turn summary. Companion to the corpus surveys in this folder:
// they answer population questions, this one opens a single session and shows the shape.
//
// usage: node analyze-stall.cjs <session.v4.jsonl.zstd> [--count "some string"]
//
// The optional --count string is a repeat marker of your own choosing (we used a short
// Chinese filler word in one case study). Leave it out and the tool simply skips that line.
const fs = require('fs');
const zlib = require('zlib');

const args = process.argv.slice(2);
const FILE = args.find((a) => !a.startsWith('--'));
if (!FILE) {
  console.error('usage: node analyze-stall.cjs <session.v4.jsonl.zstd> [--count "string"]');
  console.error('  Per-session drill-down: steps, turn/end kinds, largest reasoning block,');
  console.error('  stall-shaped steps, per-turn summary.');
  process.exit(1);
}
const ci = args.indexOf('--count');
const COUNT_STR = ci >= 0 && args[ci + 1] ? args[ci + 1] : null;

const buf = fs.readFileSync(FILE);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
if (buf.indexOf(MAGIC) === -1) {
  console.error('not a zstd multi-frame log (or empty): ' + FILE);
  process.exit(1);
}
const starts = [];
let idx = 0;
while (true) {
  const i = buf.indexOf(MAGIC, idx);
  if (i === -1) break;
  starts.push(i);
  idx = i + 4;
}
const recs = [];
for (let k = 0; k < starts.length; k++) {
  const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : buf.length;
  try {
    const out = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    for (const ln of out.split('\n')) if (ln.trim()) { try { recs.push(JSON.parse(ln)); } catch {} }
  } catch {}
}

const steps = []; // {turn, step, reasoningChars, hasText, toolCalls, outTokens}
const turnEnds = [];
let maxBlock = { chars: 0, count: 0, turn: 0, step: 0, hasText: false, toolCalls: 0 };
let countTotal = 0;

for (const r of recs) {
  if (r.type === 'assistant/message') {
    const d = r.data || {};
    const content = (d.message && d.message.content) || [];
    let rc = 0, hasText = false, tc = 0;
    for (const b of content) {
      if (b.type === 'reasoning' && typeof b.text === 'string') {
        rc += b.text.length;
        const n = COUNT_STR ? b.text.split(COUNT_STR).length - 1 : 0;
        countTotal += n;
        if (b.text.length > maxBlock.chars) {
          maxBlock = { chars: b.text.length, count: n, turn: d.turn, step: d.step, hasText: false, toolCalls: 0 };
        }
      }
      if (b.type === 'text') hasText = true;
      if (b.type === 'tool-call') tc++;
    }
    if (maxBlock.turn === d.turn && maxBlock.step === d.step) { maxBlock.hasText = hasText; maxBlock.toolCalls = tc; }
    steps.push({ turn: d.turn, step: d.step, reasoningChars: rc, hasText, toolCalls: tc, outTokens: (d.usage || {}).outputTokens || 0 });
  }
  if (r.type === 'turn/end') turnEnds.push({ turn: r.data.turn, kind: r.data.reason && r.data.reason.kind });
}

const kinds = new Map();
for (const t of turnEnds) kinds.set(t.kind, (kinds.get(t.kind) || 0) + 1);

const stalls = steps.filter((s) => s.reasoningChars > 0 && !s.hasText && s.toolCalls === 0);
console.log('file:', FILE.split(/[\\/]/).pop(), 'steps:', steps.length, 'turnEnds:', turnEnds.length);
console.log('turn/end kinds:', [...kinds.entries()].map(([k, v]) => `${k}=${v}`).join(' '));
if (COUNT_STR) console.log(`total "${COUNT_STR}" occurrences:`, countTotal);
console.log('largest single reasoning block:', JSON.stringify(maxBlock));
console.log('stall-shaped steps (reasoning>0, no text, no tool-call):', stalls.length,
  '=', (100 * stalls.length / Math.max(1, steps.length)).toFixed(1) + '%');
if (stalls.length) {
  console.log('  first stalls:', stalls.slice(0, 12).map((s) => `T${s.turn}/S${s.step}(${s.reasoningChars}c,out${s.outTokens})`).join(' '));
  const maxStall = stalls.reduce((a, b) => (b.reasoningChars > a.reasoningChars ? b : a), stalls[0]);
  console.log('  largest stall:', JSON.stringify(maxStall));
}

const perTurn = new Map();
for (const s of steps) {
  const t = perTurn.get(s.turn) || { steps: 0, rc: 0, stalls: 0, tools: 0, texts: 0 };
  t.steps++;
  t.rc += s.reasoningChars;
  if (s.reasoningChars > 0 && !s.hasText && s.toolCalls === 0) t.stalls++;
  t.tools += s.toolCalls;
  if (s.hasText) t.texts++;
  perTurn.set(s.turn, t);
}
const rows = [...perTurn.entries()].map(([turn, v]) => ({ turn, ...v, end: (turnEnds.find((x) => x.turn === turn) || {}).kind }));
console.log('--- turns (turn, steps, reasoning chars, stalls, toolCalls, texts, end) ---');
for (const r of rows) console.log(`T${r.turn}\t${r.steps}\t${r.rc}\t${r.stalls}\t${r.tools}\t${r.texts}\t${r.end}`);
