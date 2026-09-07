// `node setup/pick-session.test.mjs`. Pure, no daemon, no network.
import { pickSession } from './pick-session.mjs';

let fails = 0;
const is = (name, got, want) => {
  if (got === want) console.log(`  ok   ${name}`);
  else {
    console.log(`  FAIL ${name}\n       got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    fails += 1;
  }
};
const S = (id, url, extra = {}) => ({ sessionId: id, url, ...extra });

is('no sessions at all', pickSession([], 'http://localhost:5173'), null);
is(
  'nothing on our url',
  pickSession([S('a', 'http://localhost:9999/')], 'http://localhost:5173'),
  null,
);
is(
  'a trailing slash does not stop a match',
  pickSession([S('a', 'http://localhost:5173/x')], 'http://localhost:5173/')?.sessionId,
  'a',
);

// The one that passes a stray tab off as your install.
is(
  "somebody else's tab is never picked",
  pickSession([S('other', 'http://localhost:9999/')], 'http://localhost:5173'),
  null,
);

// The one that drives a dead tab and reports on a page nobody can see.
is(
  'a session NEW since we opened beats an older one on the same url',
  pickSession(
    [S('old', 'http://localhost:5173/'), S('new', 'http://localhost:5173/')],
    'http://localhost:5173',
    new Set(['old']),
  )?.sessionId,
  'new',
);
is(
  'among equals, a visible tab beats a hidden one',
  pickSession(
    [S('hidden', 'http://localhost:5173/', { hidden: true }), S('shown', 'http://localhost:5173/')],
    'http://localhost:5173',
  )?.sessionId,
  'shown',
);
is(
  'throttled counts as not live',
  pickSession(
    [
      S('throttled', 'http://localhost:5173/', { throttled: true }),
      S('shown', 'http://localhost:5173/'),
    ],
    'http://localhost:5173',
  )?.sessionId,
  'shown',
);
// Freshness outranks visibility: a new hidden tab is still THIS run's, and an old visible one is
// somebody's leftover that would be driven and reported on as if it were ours.
is(
  'fresh-but-hidden still beats old-but-visible',
  pickSession(
    [S('old', 'http://localhost:5173/'), S('new', 'http://localhost:5173/', { hidden: true })],
    'http://localhost:5173',
    new Set(['old']),
  )?.sessionId,
  'new',
);
is(
  'with nothing else to go on, take the most recently seen',
  pickSession(
    [
      S('stale', 'http://localhost:5173/', { hidden: true, lastSeenMs: 90000 }),
      S('recent', 'http://localhost:5173/', { hidden: true, lastSeenMs: 200 }),
    ],
    'http://localhost:5173',
  )?.sessionId,
  'recent',
);
is(
  'a malformed session does not throw',
  pickSession([null, {}, S('ok', 'http://localhost:5173/')], 'http://localhost:5173')?.sessionId,
  'ok',
);

console.log(fails === 0 ? 'PASS' : `${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
