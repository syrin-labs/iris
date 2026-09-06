/**
 * The parsing behind "which ports is my dev server listening on", separated from the commands that
 * produce it — so the Windows path can be tested from a Mac.
 *
 * This matters more than it looks. Port discovery is what rescues a dev server that prints no
 * parseable URL (react-scripts outside a TTY does exactly that, and setup used to fail CRA 100% of
 * the time waiting for a line that never comes). On POSIX that discovery uses lsof. On Windows it
 * has to use netstat, and it returned nothing there — so every Windows user of a CRA-style dev
 * server would have hit the same failure, on a code path nothing could test.
 */

/** `lsof -a -p … -iTCP -sTCP:LISTEN -P -n` NAME column → the ports in it. */
export function parseLsofListeners(out) {
  return [...new Set([...String(out).matchAll(/:(\d+)\s*$/gm)].map((m) => Number(m[1])))];
}

/**
 * `netstat -ano` → one row per LISTENING socket, with the owning pid.
 *
 * Windows prints IPv4 and IPv6 rows, and the local address column carries the port after the LAST
 * colon — `[::]:3000` has three, so anything that splits on ':' and takes [1] reads IPv6 rows as
 * port 0 and silently loses half the table.
 */
export function parseNetstatListeners(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^TCP$/i.test(f[0]) || !/^LISTENING$/i.test(f[3])) continue;
    const port = Number(f[1].slice(f[1].lastIndexOf(':') + 1));
    const pid = Number(f[4]);
    if (Number.isInteger(port) && port > 0 && Number.isInteger(pid)) rows.push({ port, pid });
  }
  return rows;
}

/**
 * Every descendant of `root`, given (pid, parentPid) pairs.
 *
 * A dev server is almost never the process we spawned: `npm run dev` spawns a shell, which spawns
 * node, which binds the port. Matching only the pid we hold finds nothing, which is
 * indistinguishable from "no server" — the failure this module exists to prevent.
 */
export function descendants(pairs, root) {
  const byParent = new Map();
  for (const { pid, ppid } of pairs) {
    if (!byParent.has(ppid)) byParent.set(ppid, []);
    byParent.get(ppid).push(pid);
  }
  const out = new Set([root]);
  const queue = [root];
  while (queue.length > 0) {
    for (const child of byParent.get(queue.shift()) ?? []) {
      if (!out.has(child)) {
        out.add(child);
        queue.push(child);
      }
    }
  }
  return [...out];
}

/** `wmic process get ParentProcessId,ProcessId` → (pid, ppid) pairs. */
export function parseWmicProcesses(out) {
  const pairs = [];
  for (const line of String(out).split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length !== 2) continue;
    const ppid = Number(f[0]);
    const pid = Number(f[1]);
    if (Number.isInteger(pid) && Number.isInteger(ppid)) pairs.push({ pid, ppid });
  }
  return pairs;
}
