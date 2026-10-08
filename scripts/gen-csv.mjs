// Usage: node scripts/gen-csv.mjs <sizeMB> <out.csv>
// Writes a realistic-looking CSV (quoted commas included) of roughly the given size.
import { createWriteStream } from 'node:fs';

const [mb = '50', out = `bench-data/${mb}mb.csv`] = process.argv.slice(2);
const target = Number(mb) * 1024 * 1024;
const cities = ['Pune', 'Delhi', 'Mumbai', 'Agra', 'Chennai', 'Kolkata', 'Jaipur', 'Surat'];
const statuses = ['paid', 'unpaid', 'refunded', ''];
const names = ['Ann', 'Bob', 'Cid', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal'];
let seed = 42;
const rnd = n => { seed = (seed * 48271) % 2147483647; return seed % n; }; // Park–Miller, exact in doubles

const ws = createWriteStream(out);
let written = 0, id = 0;
ws.write('id,name,city,status,amount,date,note\n');
const pump = () => {
  let chunk = '';
  while (chunk.length < 1 << 20) {
    id++;
    const note = rnd(10) === 0 ? `"late, follow up ""soon"""` : `order ${rnd(100000)}`;
    chunk += `${id},${names[rnd(8)]} ${rnd(1000)},${cities[rnd(8)]},${statuses[rnd(4)]},${(rnd(1000000) / 100).toFixed(2)},2026-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')},${note}\n`;
  }
  written += chunk.length;
  const ok = ws.write(chunk);
  if (written >= target) { ws.end(); console.log(`${out}: ${id} rows, ${Math.round(written / 1048576)} MB`); return; }
  if (ok) setImmediate(pump); else ws.once('drain', pump);
};
pump();
