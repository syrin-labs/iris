// `node setup/agents.test.mjs`. Pure: a pretend filesystem, so every platform's rows are checked
// from any machine. These are the assertions that stop us writing files nobody reads.
import { planAgents, CLIENTS, Confidence } from './agents.mjs';

let fails = 0;
const ok = (n) => console.log(`  ok   ${n}`);
const no = (n, got) => {
  console.log(`  FAIL ${n}\n       ${got}`);
  fails += 1;
};
const is = (n, got, want) =>
  got === want ? ok(n) : no(n, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const fs = (files) => ({
  exists: (p) => Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)),
  readFile: (p) => files[p] ?? '',
});
const plan = (files, os = 'darwin', home = '/home/u') => planAgents({ home, os, ...fs(files) });
const by = (rows, id) => rows.find((r) => r.id === id);

// Nothing installed at all: officially-documented paths are still written, so a later install is
// already wired. That is the whole point of the "future installs" case.
const bare = plan({});
is('an absent client with an official path is created', by(bare, 'zed').action, 'create');
// On a machine with NO VS Code at all, a community path is still a guess and is still refused.
is('a community path with no host layout is refused', by(bare, 'cline').action, 'skip');
is('and the refusal says why', by(bare, 'cline').why.includes('guess'), true);
// But once the host's standard layout is present, the path is evidenced rather than guessed, so an
// extension that is not installed yet still gets wired for when it is.
const vscodeLayout = plan({ '/home/u/Library/Application Support/Code/User/settings.json': '{}' });
is(
  'a community path IS written when the host layout exists',
  by(vscodeLayout, 'cline').action,
  'create',
);
is('the same for roo', by(vscodeLayout, 'roo-code').action, 'create');

// The gap that exists on a real machine today: VS Code user scope.
is(
  'vscode user-scope config is targeted, not the project one',
  by(bare, 'vscode-user').file,
  '/home/u/Library/Application Support/Code/User/mcp.json',
);
is(
  'windows vscode goes to AppData',
  by(plan({}, 'win32'), 'vscode-user').file,
  // Backslashes, because a win32 row is a WINDOWS path. This expectation used to be the posix form,
  // which was only ever produced by running the win32 planner on a mac: the join followed the host
  // rather than the `os` argument beside it. See joinFor in agents.mjs.
  '\\home\\u\\AppData\\Roaming\\Code\\User\\mcp.json',
);
is('linux zed follows XDG', by(plan({}, 'linux'), 'zed').file, '/home/u/.config/zed/settings.json');

// Keys are per-client and getting them wrong writes a file the client ignores.
is('zed uses context_servers, not mcpServers', by(bare, 'zed').key, 'context_servers');
is('amp uses the dotted top-level key', by(bare, 'amp').key, 'amp.mcpServers');
is('vscode uses servers, not mcpServers', by(bare, 'vscode-user').key, 'servers');

// Never clobber. An existing unrelated server must survive; a foreign `reticle` must not be replaced.
const withOthers = plan({
  '/home/u/.warp/.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
});
is('an existing config is merged, not overwritten', by(withOthers, 'warp').action, 'merge');
const foreign = plan({
  '/home/u/.warp/.mcp.json': JSON.stringify({
    mcpServers: { reticle: { command: 'somebody-elses' } },
  }),
});
is('a foreign reticle entry is left alone', by(foreign, 'warp').action, 'manual');
const ours = plan({
  '/home/u/.warp/.mcp.json': JSON.stringify({
    mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/server', 'mcp'] } },
  }),
});
is('our own entry is recognised as already done', by(ours, 'warp').action, 'already');

// A config with comments is JSONC. Parsing it as JSON and rewriting would strip the comments.
const jsonc = plan({ '/home/u/.config/zed/settings.json': '{ // theme\n "theme": "dark" }' });
is('a commented config is left for a human', by(jsonc, 'zed').action, 'manual');

// YAML is a list with names; we do not rewrite it under any circumstance.
is(
  'continue is manual when installed',
  by(plan({ '/home/u/.continue/config.yaml': 'x' }), 'continue').action,
  'manual',
);
// A NEW yaml file has nobody's formatting to destroy, so it can be written outright.
is(
  'continue is created when there is no config to damage',
  by(bare, 'continue').action,
  'create-yaml',
);

// A detected community client IS written — detection is the evidence its path is real.
const clineThere = plan({
  '/home/u/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/x': '',
});
is('a detected community client is created', by(clineThere, 'cline').action, 'create');

is(
  'every client declares a confidence',
  CLIENTS.every((c) => Object.values(Confidence).includes(c.confidence)),
  true,
);
is(
  'every client declares all three platforms',
  CLIENTS.every((c) => c.paths.darwin && c.paths.linux && c.paths.win32),
  true,
);

console.log(fails === 0 ? 'PASS' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
