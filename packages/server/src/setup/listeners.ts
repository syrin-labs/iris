/**
 * Which ports a process tree is listening on, parsed from the tools that can answer that.
 *
 * Kept separate from the commands that produce the text so the Windows behaviour is testable from
 * any machine. That is not a stylistic preference: port discovery on Windows returned nothing at
 * all until this was extracted, so a dev server that prints no parseable URL was undiscoverable
 * there — and `react-scripts` prints no parseable URL outside a tty, which makes it the majority
 * platform's most common React setup.
 */

/** One LISTENING socket and the process that owns it. */
interface Listener {
  readonly port: number;
  readonly pid: number;
}

/** `lsof -a -p <pids> -iTCP -sTCP:LISTEN -P -n`, NAME column only. */
export function parseLsofPorts(out: string): number[] {
  const ports = new Set<number>();
  for (const m of String(out).matchAll(/:(\d+)\s*$/gm)) ports.add(Number(m[1]));
  return [...ports];
}

const NETSTAT_PROTO = 'TCP';
const NETSTAT_STATE = 'LISTENING';
const NETSTAT_MIN_COLUMNS = 5;

/**
 * `netstat -ano` on Windows.
 *
 * The port is whatever follows the LAST colon: `[::]:3000` has three of them, so splitting on ':'
 * and taking index 1 reads every IPv6 row as port 0 and silently drops half the table.
 */
export function parseNetstatListeners(out: string): Listener[] {
  const rows: Listener[] = [];
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < NETSTAT_MIN_COLUMNS) continue;
    if (f[0]?.toUpperCase() !== NETSTAT_PROTO || f[3]?.toUpperCase() !== NETSTAT_STATE) continue;
    const local = f[1] ?? '';
    const port = Number(local.slice(local.lastIndexOf(':') + 1));
    const pid = Number(f[4]);
    if (Number.isInteger(port) && port > 0 && Number.isInteger(pid)) rows.push({ port, pid });
  }
  return rows;
}

/** One (pid, parent) pair, as `wmic process get ParentProcessId,ProcessId` prints them. */
export interface ProcessPair {
  readonly pid: number;
  readonly ppid: number;
}

export function parseWmicProcesses(out: string): ProcessPair[] {
  const pairs: ProcessPair[] = [];
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 2) continue;
    const ppid = Number(f[0]);
    const pid = Number(f[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) pairs.push({ pid, ppid });
  }
  return pairs;
}

/**
 * `root` and everything descended from it.
 *
 * The dev server is almost never the process we spawned: `npm run dev` starts a shell, which starts
 * node, which binds the port. Matching only the pid we hold finds nothing, and nothing is
 * indistinguishable from "no server".
 */
export function descendants(pairs: readonly ProcessPair[], root: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const { pid, ppid } of pairs) {
    const kids = byParent.get(ppid);
    if (kids === undefined) byParent.set(ppid, [pid]);
    else kids.push(pid);
  }
  const found = new Set<number>([root]);
  const queue: number[] = [root];
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) continue;
    for (const child of byParent.get(next) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return [...found];
}
