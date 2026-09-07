import { describe, expect, it } from 'vitest';
import {
  descendants,
  parseLsofPorts,
  parseNetstatListeners,
  parseWmicProcesses,
} from './listeners.js';

describe('port discovery', () => {
  it('reads ports out of the lsof NAME column', () => {
    expect(parseLsofPorts('127.0.0.1:3000\n*:5173\n[::1]:8080')).toEqual([3000, 5173, 8080]);
  });

  it('has nothing to report when nothing listens', () => {
    expect(parseLsofPorts('')).toEqual([]);
  });
});

// Real `netstat -ano` output. The IPv6 rows are the point: splitting the local address on ':' and
// taking index 1 reads `[::]:3000` as port 0, which silently loses half the table on the one
// platform where this is the only way to find a port at all.
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4812
  TCP    [::]:3000              [::]:0                 LISTENING       4812
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9001
  TCP    192.168.1.4:52344      104.18.2.1:443         ESTABLISHED     7777
  UDP    0.0.0.0:5353           *:*                                    600
`;

describe('netstat parsing', () => {
  it('keeps only LISTENING TCP rows', () => {
    expect(
      parseNetstatListeners(NETSTAT)
        .map((r) => r.port)
        .sort((a, b) => a - b),
    ).toEqual([3000, 3000, 5173]);
  });

  it('reads the port after the LAST colon, so IPv6 rows survive', () => {
    expect(parseNetstatListeners('  TCP    [::]:3000    [::]:0    LISTENING    4812')).toEqual([
      { port: 3000, pid: 4812 },
    ]);
  });

  it('ignores established connections and udp', () => {
    const pids = parseNetstatListeners(NETSTAT).map((r) => r.pid);
    expect(pids).not.toContain(7777);
    expect(pids).not.toContain(600);
  });

  it('treats unparseable output as no listeners rather than throwing', () => {
    expect(parseNetstatListeners('not netstat output at all')).toEqual([]);
  });
});

describe('process descendants', () => {
  // `npm run dev` starts a shell, which starts node, which binds the port. Matching only the pid we
  // hold finds nothing, and nothing looks exactly like "no server is running".
  const TREE = [
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 200 },
    { pid: 400, ppid: 999 },
  ];

  it('walks past the shell to the process that actually binds', () => {
    expect(descendants(TREE, 100).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('does not sweep in an unrelated tree', () => {
    expect(descendants(TREE, 100)).not.toContain(400);
  });

  it('terminates on a cycle', () => {
    expect(
      descendants(
        [
          { pid: 1, ppid: 2 },
          { pid: 2, ppid: 1 },
        ],
        1,
      ).sort((a, b) => a - b),
    ).toEqual([1, 2]);
  });

  it('reads wmic columns as parent then child', () => {
    expect(
      parseWmicProcesses('ParentProcessId  ProcessId\n100              200\n200              300'),
    ).toEqual([
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ]);
  });
});

// The fallback source when `wmic` is absent, which Microsoft has been making the normal case.
// node-effects asks PowerShell for the same pairs and hands the output to this same parser, so the
// shape it prints is a contract. If this stops reading it, Windows silently loses port discovery
// and `init` reports a healthy dev server as hung.
describe('the PowerShell fallback prints a shape this parser reads', () => {
  it('reads `ParentProcessId ProcessId` lines with CRLF endings', () => {
    expect(parseWmicProcesses('1234 5678\r\n4 8\r\n\r\n')).toEqual([
      { pid: 5678, ppid: 1234 },
      { pid: 8, ppid: 4 },
    ]);
  });

  it('ignores the blank and ragged lines PowerShell adds', () => {
    expect(parseWmicProcesses('\r\n  \r\n7 9\r\nnot numbers here\r\n')).toEqual([
      { pid: 9, ppid: 7 },
    ]);
  });
});
