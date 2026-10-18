// Dump ONE assistant message from a DSH v4 session log (multi-frame zstd), for case studies.
// Read-only. Shows block types, token usage, the head and tail of the reasoning text, how many
// claim-words it contains, and the last non-empty lines — i.e. what you need to tell "the agent
// was still thinking" apart from "the agent had decided and never emitted".
//
// usage: node dump-step.cjs <session.v4.jsonl.zstd> <turn> <step> [--claims "a,b,c"] [--head N] [--tail N]
//
// ⚠️ The output includes RAW REASONING TEXT. Redact before sharing.
const fs = require('fs');
const zlib = require('zlib');

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const FILE = positional[0];
const T = Number(positional[1]);
const S = Number(positional[2]);
if (!FILE || !Number.isFinite(T) || !Number.isFinite(S)) {
  console.error('usage: node dump-step.cjs <session.v4.jsonl.zstd> <turn> <step> [--claims "a,b,c"] [--head N] [--tail N]');
  console.error('  Dumps one assistant message: block types, usage, head/tail of reasoning,');
  console.error('  claim-word counts, and the last 12 non-empty lines.');
  console.error('  ⚠️ Output contains raw reasoning text — redact before sharing.');
  process.exit(1);
}
function opt(name, dflt) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
}
const CLAIMS = opt('--claims', 'done,finished,completed,shipped,all set').split(',').map((s) => s.trim()).filter(Boolean);
const HEAD_N = Number(opt('--head', 400));
const TAIL_N = Number(opt('--tail', 700));

const buf = fs.readFileSync(FILE);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
let idx = 0;
while (true) {
  const i = buf.indexOf(MAGIC, idx);
  if (i === -1) break;
  starts.push(i);
  idx = i + 4;
}

let found = null;
for (let k = 0; k < starts.length; k++) {
  const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] : buf.length;
  let out;
  try { out = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8'); } catch { continue; }
  for (const ln of out.split('\n')) {
    if (!ln.trim()) continue;
    let r;
    try { r = JSON.parse(ln); } catch { continue; }
    if (!found && r.type === 'assistant/message' && r.data.turn === T && r.data.step === S) found = r;
    if (found && !found.turnEnd && r.type === 'turn/end' && r.data.turn === T) found.turnEnd = r.data.reason;
  }
  if (found && found.turnEnd) break;
}
if (!found) { console.log('not found: turn ' + T + ' step ' + S); process.exit(0); }

const blocks = found.data.message.content || [];
const reasoning = blocks.filter((b) => b.type === 'reasoning').map((b) => b.text).join('\n');
console.log('blocks:', blocks.map((b) => b.type).join(','));
console.log('reasoning chars:', reasoning.length, 'usage:', JSON.stringify(found.data.usage));
console.log('turn/end:', JSON.stringify(found.turnEnd));
console.log('\n=== HEAD ' + HEAD_N + ' ===\n' + reasoning.slice(0, HEAD_N));
console.log('\n=== TAIL ' + TAIL_N + ' ===\n' + reasoning.slice(-TAIL_N));

console.log('\n=== claim words ===');
for (const w of CLAIMS) {
  const n = reasoning.split(w).length - 1;
  if (n) console.log(`  ${w}: ${n}`);
}

const lines = reasoning.split('\n').filter((l) => l.trim());
console.log('\n=== LAST 12 non-empty lines ===');
for (const l of lines.slice(-12)) console.log('  |' + l.slice(0, 160));
