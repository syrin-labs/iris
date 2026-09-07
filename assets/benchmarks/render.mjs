// Render every src/*.html benchmark card to a crisp 2x PNG in assets/readme/.
// Each HTML declares its size on line 1 as:  <!--SIZE:WIDTHxHEIGHT-->
// Run: node assets/benchmarks/render.mjs
import { chromium } from 'playwright';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, 'src');
const files = readdirSync(srcDir).filter((f) => f.endsWith('.html')).sort();

const browser = await chromium.launch();
let ok = 0;
for (const f of files) {
  const html = readFileSync(join(srcDir, f), 'utf8');
  const m = html.match(/<!--SIZE:(\d+)x(\d+)-->/);
  const width = m ? Number(m[1]) : 1600;
  const height = m ? Number(m[2]) : 1000;
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  await page.goto('file://' + join(srcDir, f));
  try { await page.evaluate(() => document.fonts.ready); } catch {}
  await page.waitForTimeout(500); // let fonts/layout settle
  const out = join(here, '..', 'readme', f.replace(/\.html$/, '.png'));
  await page.screenshot({ path: out });
  await page.close();
  ok++;
  process.stdout.write(`✓ ${f} → ${width}x${height}\n`);
}
await browser.close();
process.stdout.write(`\nrendered ${ok} benchmark(s)\n`);
