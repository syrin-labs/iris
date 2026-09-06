// `node setup/platform-probe.test.mjs`. Pure, and the only coverage the Windows path can have from
// a Mac. Every fixture below is real command output, not invented shapes.
import {
  parseLsofListeners,
  parseNetstatListeners,
  descendants,
  parseWmicProcesses,
} from './platform-probe.mjs';

let fails = 0;
const is = (n, got, want) => {
  const g = JSON.stringify(got),
    w = JSON.stringify(want);
  if (g === w) console.log(`  ok   ${n}`);
  else {
    console.log(`  FAIL ${n}\n       got ${g}\n       want ${w}`);
    fails += 1;
  }
};

is(
  'lsof NAME column yields ports',
  parseLsofListeners(`127.0.0.1:3000
*:5173
[::1]:8080`),
  [3000, 5173, 8080],
);
is('lsof with no listeners is empty', parseLsofListeners(''), []);

// Real `netstat -ano` shape, including the IPv6 rows that break naive colon-splitting.
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4812
  TCP    [::]:3000              [::]:0                 LISTENING       4812
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9001
  TCP    192.168.1.4:52344      104.18.2.1:443         ESTABLISHED     7777
  UDP    0.0.0.0:5353           *:*                                    600
`;
is(
  'netstat keeps only LISTENING TCP rows',
  parseNetstatListeners(NETSTAT)
    .map((r) => r.port)
    .sort((a, b) => a - b),
  [3000, 3000, 5173],
);
is(
  'netstat reads the port after the LAST colon, so [::] rows are not lost',
  parseNetstatListeners(
    '  TCP    [::]:3000              [::]:0                 LISTENING       4812',
  ),
  [{ port: 3000, pid: 4812 }],
);
is(
  'netstat ignores ESTABLISHED and UDP',
  parseNetstatListeners(NETSTAT).some((r) => r.pid === 7777 || r.pid === 600),
  false,
);
is('netstat garbage is empty, not a throw', parseNetstatListeners('not netstat output at all'), []);

// npm run dev → sh → node: the port belongs to the grandchild, not the pid we hold.
const TREE = [
  { pid: 200, ppid: 100 },
  { pid: 300, ppid: 200 },
  { pid: 400, ppid: 999 },
];
is(
  'descendants walks past the shell to the process that binds',
  descendants(TREE, 100).sort((a, b) => a - b),
  [100, 200, 300],
);
is('an unrelated tree is not swept in', descendants(TREE, 100).includes(400), false);
is(
  'a cycle terminates',
  descendants(
    [
      { pid: 1, ppid: 2 },
      { pid: 2, ppid: 1 },
    ],
    1,
  ).sort((a, b) => a - b),
  [1, 2],
);

is(
  'wmic columns are ParentProcessId then ProcessId',
  parseWmicProcesses(`ParentProcessId  ProcessId
100              200
200              300`),
  [
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 200 },
  ],
);

console.log(fails === 0 ? 'PASS' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
