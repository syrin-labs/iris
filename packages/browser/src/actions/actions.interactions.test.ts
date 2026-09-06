import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventType } from '@reticlehq/core';
import { createCommandRegistry } from '../commands/commands.js';
import { executeAction } from './actions.js';
import { installScroll } from '../observers/scroll.js';
import { installOverlay } from '../presenter/overlay.js';
import { refs } from '../dom/refs.js';

describe('drag', () => {
  it('fires a pointer/mouse drag from source to target (async, yields frames)', async () => {
    document.body.innerHTML = '<div id="a">A</div><div id="b">B</div>';
    const a = document.getElementById('a') as HTMLElement;
    const b = document.getElementById('b') as HTMLElement;
    const down = vi.fn();
    const up = vi.fn();
    a.addEventListener('mousedown', down);
    b.addEventListener('mouseup', up);
    await executeAction(refs.refFor(a), 'drag', { toRef: refs.refFor(b) });
    expect(down).toHaveBeenCalled();
    expect(up).toHaveBeenCalled();
  });
});

describe('blur → focusout (React commit-on-blur)', () => {
  it('dispatches a bubbling focusout so delegated listeners fire', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLInputElement;
    const onFocusOut = vi.fn();
    document.addEventListener('focusout', onFocusOut);
    input.focus();
    void executeAction(refs.refFor(input), 'blur');
    expect(onFocusOut).toHaveBeenCalled();
    document.removeEventListener('focusout', onFocusOut);
  });

  /**
   * EXACTLY once. `el.blur()` on a focused element already emits a bubbling `focusout` natively —
   * verified in this jsdom and true in every browser — so synthesizing a second one made React's
   * delegated root listener run `onBlur` TWICE.
   *
   * Reported from the field on React 19 + Vite: one `onBlur={() => mutate(...)}`, one render site,
   * no StrictMode, and Reticle reported a `duplicate-request` contradiction. The double submit was
   * ours. That is the worst failure this product has — a defect we invent and hand to a human as
   * real — and it also makes every `net.count` assertion around a blur-to-save form untrustworthy.
   *
   * The old assertion was `toHaveBeenCalled()`, which is true for one call and for two.
   */
  it('fires focusout ONCE on a focused element — not once natively and once synthetically', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLInputElement;
    const onFocusOut = vi.fn();
    document.addEventListener('focusout', onFocusOut);
    input.focus();

    void executeAction(refs.refFor(input), 'blur');

    expect(onFocusOut, 'a second focusout is a phantom duplicate-request').toHaveBeenCalledTimes(1);
    document.removeEventListener('focusout', onFocusOut);
  });

  it('still reaches a delegated listener when the element was NOT focused', () => {
    // The case the synthetic dispatch exists for: `el.blur()` is a no-op on an unfocused element,
    // so nothing native fires and the commit-on-blur handler would never run.
    document.body.innerHTML = '<input /><button>elsewhere</button>';
    const input = document.querySelector('input') as HTMLInputElement;
    const onFocusOut = vi.fn();
    document.addEventListener('focusout', onFocusOut);

    void executeAction(refs.refFor(input), 'blur');

    expect(onFocusOut).toHaveBeenCalledTimes(1);
    document.removeEventListener('focusout', onFocusOut);
  });

  it('does not double-fire inside a shadow root either', () => {
    // `document.activeElement` reports the shadow HOST, so keying on it would read a genuinely
    // focused element as unfocused and take the double-dispatch path. The check reads the element's
    // own root instead.
    document.body.innerHTML = '<div id="host"></div>';
    const host = document.getElementById('host') as HTMLElement;
    const shadow = host.attachShadow({ mode: 'open' });
    const input = document.createElement('input');
    shadow.appendChild(input);
    const onFocusOut = vi.fn();
    document.addEventListener('focusout', onFocusOut);
    input.focus();

    void executeAction(refs.refFor(input), 'blur');

    expect(onFocusOut).toHaveBeenCalledTimes(1);
    document.removeEventListener('focusout', onFocusOut);
  });

  it('fires the non-bubbling `blur` event once too', () => {
    document.body.innerHTML = '<input />';
    const input = document.querySelector('input') as HTMLInputElement;
    const onBlur = vi.fn();
    input.addEventListener('blur', onBlur);
    input.focus();

    void executeAction(refs.refFor(input), 'blur');

    expect(onBlur, 'an inline onblur= handler must not run twice either').toHaveBeenCalledTimes(1);
  });
});

describe('hover holdMs', () => {
  it('resolves after the dwell so timer-gated reveals can mount', async () => {
    document.body.innerHTML = '<div id="h">hover</div>';
    const el = document.getElementById('h') as HTMLElement;
    const r = await executeAction(refs.refFor(el), 'hover', { holdMs: 20 });
    expect(r).toMatchObject({ ok: true, action: 'hover' });
    expect(r.effect.dispatched).toBe(true);
  });
});

describe('scroll observer', () => {
  it('emits a scroll position event', () => {
    const emit = vi.fn();
    const stop = installScroll(emit);
    window.dispatchEvent(new Event('scroll'));
    const scrollEvents = emit.mock.calls.filter((c) => c[0] === EventType.SCROLL_POSITION);
    expect(scrollEvents.length).toBeGreaterThan(0);
    stop();
  });
});

describe('webmcp passthrough', () => {
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>)['modelContext'];
  });

  it('calls a navigator.modelContext tool via the act command', async () => {
    const callTool = vi.fn((name: string) => Promise.resolve({ called: name }));
    (navigator as unknown as Record<string, unknown>)['modelContext'] = { callTool };
    const reg = createCommandRegistry();
    const handler = reg.get('act');
    if (handler === undefined) throw new Error('no act handler');
    const result = await handler({
      action: 'webmcp',
      args: { tool: 'search', params: { q: 'x' } },
    });
    expect(callTool).toHaveBeenCalledWith('search', { q: 'x' });
    expect(result).toEqual({ called: 'search' });
  });

  it('blocks dangerous tools without explicit confirmation', async () => {
    const callTool = vi.fn(() => Promise.resolve({ ok: true }));
    (navigator as unknown as Record<string, unknown>)['modelContext'] = { callTool };
    const reg = createCommandRegistry();
    const handler = reg.get('act');
    if (handler === undefined) throw new Error('no act handler');
    await expect(
      handler({ action: 'webmcp', args: { tool: 'delete_account', params: {} } }),
    ).rejects.toThrow(/confirmDangerous/);
    await handler({
      action: 'webmcp',
      args: { tool: 'delete_account', params: {}, confirmDangerous: true },
    });
    expect(callTool).toHaveBeenCalledOnce();
  });
});

describe('dangerous action confirmation', () => {
  it('blocks a destructive click until explicitly confirmed', async () => {
    document.body.innerHTML = '<button>Delete account</button>';
    const button = document.querySelector('button') as HTMLButtonElement;
    const ref = refs.refFor(button);
    const clicked = vi.fn();
    button.addEventListener('click', clicked);
    await expect(executeAction(ref, 'click')).rejects.toThrow(/confirmDangerous/);
    expect(clicked).not.toHaveBeenCalled();
    await executeAction(ref, 'click', { confirmDangerous: true });
    expect(clicked).toHaveBeenCalledOnce();
  });
});

describe('dev overlay', () => {
  it('mounts and unmounts a status chip', () => {
    const handle = installOverlay();
    expect(document.querySelector('[data-reticle-overlay]')).not.toBeNull();
    handle.update({ connected: true, events: 3 });
    handle.destroy();
    expect(document.querySelector('[data-reticle-overlay]')).toBeNull();
  });
});

describe('fill without a value', () => {
  /**
   * A `fill` carrying no value must FAIL, not quietly empty the field.
   *
   * `asString(args['value'])` defaults to '', so a fill whose value never arrived was indistinguishable
   * from `clear` — it wiped whatever the user (or the app) had put there, dispatched a real input
   * event so React committed the empty string to state, and reported ok:true with no contradiction.
   *
   * This is easy to trigger: the tool takes the value NESTED (`{ref, action:'fill', args:{value}}`),
   * so passing `value` at the top level silently becomes a destructive clear. Measured on bench-app's
   * login form — "admin@reticle.dev" was wiped and the act reported success.
   *
   * `clear` already exists for emptying a field on purpose, and its own branch throws rather than
   * report a silent success for a target it cannot clear. Fill follows the same rule.
   */
  it('throws instead of silently clearing the field', async () => {
    document.body.innerHTML = '<input id="f" value="keep-me" />';
    const el = document.getElementById('f') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'fill', {})).rejects.toThrow(/value/i);
    expect(el.value, 'the existing value must survive a malformed fill').toBe('keep-me');
  });

  it('still fills normally when a value is given', async () => {
    document.body.innerHTML = '<input id="g" value="old" />';
    const el = document.getElementById('g') as HTMLInputElement;
    await executeAction(refs.refFor(el), 'fill', { value: 'new' });
    expect(el.value).toBe('new');
  });

  it('allows an explicit empty string, which is a deliberate clear', async () => {
    document.body.innerHTML = '<input id="h" value="old" />';
    const el = document.getElementById('h') as HTMLInputElement;
    await executeAction(refs.refFor(el), 'fill', { value: '' });
    expect(el.value).toBe('');
  });
});

describe('type and select refuse malformed calls too', () => {
  /**
   * Same family as the valueless fill: a missing argument defaulted to '' and turned a broken call
   * into a silent success. `type` appended nothing and reported ok:true — an agent believes it typed.
   */
  it('type throws instead of appending nothing', async () => {
    document.body.innerHTML = '<input id="t" value="abc" />';
    const el = document.getElementById('t') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'type', {})).rejects.toThrow(/text/i);
    expect(el.value).toBe('abc');
  });

  /**
   * The worst of the three: `select` with no value assigned '' to the <select>. No option carries
   * that value, so the browser sets selectedIndex to -1 — DESELECTING everything — and the action
   * reported ok:true. A form the agent believes it filled is now emptier than before it acted.
   */
  it('select throws instead of deselecting everything', async () => {
    document.body.innerHTML =
      '<select id="s"><option value="a">A</option><option value="b">B</option></select>';
    const el = document.getElementById('s') as HTMLSelectElement;
    el.value = 'b';
    await expect(executeAction(refs.refFor(el), 'select', {})).rejects.toThrow(/value/i);
    expect(el.value, 'the existing selection must survive').toBe('b');
  });

  it('select still works for an option that exists', async () => {
    document.body.innerHTML =
      '<select id="s3"><option value="a">A</option><option value="b">B</option></select>';
    const el = document.getElementById('s3') as HTMLSelectElement;
    await executeAction(refs.refFor(el), 'select', { value: 'b' });
    expect(el.value).toBe('b');
  });
});

describe('fill and type refuse fields a user could not edit', () => {
  /**
   * A synthetic fill can write where a person cannot.
   *
   * `readonly` and `disabled` block USER input, not scripted assignment — so the prototype value
   * setter sails straight through both. Measured: filling a `readonly` input reported
   * `ok:true, valueChanged:true` with NOTHING in the effect block marking it read-only, and a
   * `disabled` input reported the same with only `enabled:false` to hint at it. The agent is told it
   * edited a field, and the app is now in a state no user could have produced — so any conclusion
   * drawn from what follows is about software nobody can actually operate.
   *
   * This is the same rule the click path already applies with `occluded` ("a real user could not
   * click it"), and it matches Playwright, which refuses to fill a non-editable element rather than
   * forcing the value in.
   */
  it('refuses to fill a readonly input, leaving it untouched', async () => {
    document.body.innerHTML = '<input id="ro" value="locked" readonly />';
    const el = document.getElementById('ro') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'fill', { value: 'new' })).rejects.toThrow(
      /readonly/i,
    );
    expect(el.value).toBe('locked');
  });

  it('refuses to fill a disabled input, leaving it untouched', async () => {
    document.body.innerHTML = '<input id="di" value="locked" disabled />';
    const el = document.getElementById('di') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'fill', { value: 'new' })).rejects.toThrow(
      /disabled/i,
    );
    expect(el.value).toBe('locked');
  });

  it('refuses to type into a readonly input', async () => {
    document.body.innerHTML = '<input id="ro2" value="locked" readonly />';
    const el = document.getElementById('ro2') as HTMLInputElement;
    await expect(executeAction(refs.refFor(el), 'type', { text: 'x' })).rejects.toThrow(
      /readonly/i,
    );
    expect(el.value).toBe('locked');
  });

  it('still fills an ordinary editable input', async () => {
    document.body.innerHTML = '<input id="ok" value="old" />';
    const el = document.getElementById('ok') as HTMLInputElement;
    await executeAction(refs.refFor(el), 'fill', { value: 'new' });
    expect(el.value).toBe('new');
  });
});

describe('a contenteditable target is refused legibly', () => {
  /**
   * Rich-text editors (TipTap, Quill, ProseMirror, Slate, Lexical) are all `[contenteditable]`, and
   * `fill` handles only input/textarea — so an agent driving a comment box or CMS body gets
   * "cannot fill a <div>", which reads as "you picked the wrong element" when the truth is "this
   * surface is not supported yet". Naming it costs nothing and stops the reader hunting for a
   * better selector that does not exist.
   *
   * Support is deliberately NOT faked here: setting textContent would update the DOM while the
   * editor's own model kept the old value, and the tool would report ok:true for content the app
   * will never submit — a false green in exactly the apps the feature would be for.
   */
  it('names contenteditable rather than blaming the element type', async () => {
    document.body.innerHTML = '<div id="rt" contenteditable="true">hello</div>';
    const el = document.getElementById('rt') as HTMLElement;
    await expect(executeAction(refs.refFor(el), 'fill', { value: 'x' })).rejects.toThrow(
      /contenteditable/i,
    );
    expect(el.textContent, 'the existing content must not be touched').toBe('hello');
  });
});

/**
 * Hold-to-confirm controls were undriveable, and the agent's own workaround was to give up and ask
 * the human to click the button.
 *
 * Reported via `reticle_feedback` (`kind: gap`). Every action that touches an element pressed and
 * released in the same synchronous block, so any UI whose contract is *"the button is down for N
 * milliseconds"* could not be expressed. The reported case: `mousedown` starts a 1.2s fill, and a
 * `mouseup` before it completes cancels the confirm — deliberate anti-misclick design, and common
 * (hold-to-delete in dashboards, hold-to-record in chat, long-press menus).
 *
 * Nothing was misreported. `domMutatedWithin:7ms` was true and the absent DELETE was the app
 * behaving as designed. Reticle simply could not produce the input.
 *
 * `args.holdMs` on `click` rather than separate press/release actions, for the reason the report
 * gives: a single call owns both halves. An agent that presses and then errors, or hits its context
 * limit, would otherwise leave the page with a button held down and nobody to release it, and the
 * next tool call inherits a corrupted input state.
 */
describe('click holdMs — hold-to-confirm controls', () => {
  /** A control that fires only if the pointer stays down past `thresholdMs`. */
  function holdToConfirm(thresholdMs: number): { el: HTMLElement; fired: () => boolean } {
    // Neutral label on purpose. "Hold to delete" trips the destructive-action guard — correctly —
    // and these tests are about the hold mechanism, not about that guard.
    document.body.innerHTML = '<button id="armed">Press and hold</button>';
    const el = document.getElementById('armed') as HTMLElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let confirmed = false;
    el.addEventListener('mousedown', () => {
      timer = setTimeout(() => {
        confirmed = true;
      }, thresholdMs);
    });
    el.addEventListener('mouseup', () => {
      if (timer !== undefined) clearTimeout(timer);
    });
    return { el, fired: () => confirmed };
  }

  it('holds the pointer down long enough to arm the control', async () => {
    // One-sided on purpose: a sleep can overshoot on a loaded runner but never undershoot, so
    // "asked for 200ms, armed a 20ms control" cannot fail for machine reasons. The reverse
    // assertion — a short hold must NOT arm a long control — WOULD be a machine statement, and is
    // expressed relatively below instead.
    const { el, fired } = holdToConfirm(20);
    await executeAction(refs.refFor(el), 'click', { holdMs: 200 });
    expect(fired(), 'the press and release were still in one synchronous block').toBe(true);
  });

  /**
   * The half that actually catches a regression, expressed as a BOUND rather than a duration.
   *
   * The first version of this asserted that `holdMs: 5` fails to arm an 80ms control. That is a
   * statement about the machine: Windows timer granularity is ~15.6ms and worse under load, so a
   * 5ms sleep can genuinely exceed 80ms and arm it. **It failed on Windows CI, which is exactly the
   * failure mode CLAUDE.md describes — "fails only under parallel load, i.e. only in CI".**
   *
   * What is actually being defended is that the hold is CALLER-CONTROLLED rather than fixed: a hold
   * that always lasts the same time is indistinguishable from a click. Comparing two holds measured
   * on the same machine in the same run says that without asking the clock to behave.
   */
  it('a shorter hold is measurably shorter than a longer one', async () => {
    const { el } = holdToConfirm(5_000); // never fires; this test is about the measurement
    const brief = await executeAction(refs.refFor(el), 'click', { holdMs: 1 });
    const long = await executeAction(refs.refFor(el), 'click', { holdMs: 300 });
    expect(
      long.effect.heldMs,
      'both holds took the same time — the duration is not caller-controlled',
    ).toBeGreaterThan(brief.effect.heldMs ?? 0);
  });

  it('an ordinary click still works and is not slowed by the feature', async () => {
    document.body.innerHTML = '<button id="plain">Save</button>';
    const el = document.getElementById('plain') as HTMLElement;
    const clicked = vi.fn();
    el.addEventListener('click', clicked);
    const r = await executeAction(refs.refFor(el), 'click', {});
    expect(clicked).toHaveBeenCalled();
    expect(r).toMatchObject({ ok: true, action: 'click' });
  });

  /**
   * Reports a measurement at all — deliberately NOT "at least the requested 25ms".
   *
   * The first version asserted `heldMs >= 25`, reasoning that a sleep can overshoot but never return
   * early. That reasoning is sound and the assertion still flaked: it failed once under
   * full-monorepo parallelism and passed 9/9 in isolation. I could not reproduce it, which is
   * precisely why it should not be an absolute number — an assertion I cannot explain failing is one
   * I cannot defend keeping.
   *
   * The contract has two halves and neither needs a duration: the field is PRESENT and measured
   * (here), and it SCALES with what was asked for (the test above). Together those say "this is a
   * real measurement of a caller-controlled hold", which is the whole claim.
   */
  it('reports a measured hold rather than echoing the request', async () => {
    const { el } = holdToConfirm(5_000);
    const r = await executeAction(refs.refFor(el), 'click', { holdMs: 25 });
    expect(r.effect.heldMs, 'no way to tell a real hold from a claimed one').toEqual(
      expect.any(Number),
    );
    expect(
      r.effect.heldMs,
      'a hold that measures negative is a broken clock',
    ).toBeGreaterThanOrEqual(0);
  });
});

/**
 * An `upload` whose file was never described is a FAILED call, not a request for a placeholder.
 *
 * The branch built `new File([asString(args.content, 'reticle test file')], asString(args.name,
 * 'file.txt'))`, so a call whose keys were all unrecognised — the field report sent `args.files` —
 * uploaded a 17-byte text file and returned ok:true. The server answered 200, the UI refreshed, and
 * every signal the agent could read said the pipeline had processed its PDF. That is a manufactured
 * green on the write path, and it is the same shape `drag` already refuses one branch below: an act
 * that reports success over something it never did.
 *
 * The refusal names the keys upload accepts, so a caller that guessed can correct in one turn
 * instead of guessing again.
 */
describe('upload refuses to invent a file nobody asked for', () => {
  const fileInput = (): HTMLInputElement => {
    document.body.innerHTML = '<input type="file" />';
    return document.querySelector('input') as HTMLInputElement;
  };

  it('REFUSES when every key it was given is one it does not read', async () => {
    const el = fileInput();
    await expect(
      executeAction(refs.refFor(el), 'upload', { files: ['/tmp/pitch.pdf'] }),
    ).rejects.toThrow(/content/);
    expect(el.files?.length ?? 0, 'nothing may be uploaded by a refused call').toBe(0);
  });

  it('REFUSES { path, name } without a daemon — path is stripped by the daemon before reaching the browser', async () => {
    // Without a daemon in the loop, path arrives at the browser unstripped. The guard must refuse
    // it — otherwise new File(["reticle test file"], "Onboarding_v2.pdf") uploads fabricated bytes
    // under the correct filename, which is the exact false green assertUploadArgs exists to prevent.
    const el = fileInput();
    await expect(
      executeAction(refs.refFor(el), 'upload', { path: '/tmp/pitch.pdf', name: 'pitch.pdf' }),
    ).rejects.toThrow(/upload needs/);
  });

  it('REFUSES { path } alone without a daemon', async () => {
    const el = fileInput();
    await expect(
      executeAction(refs.refFor(el), 'upload', { path: '/tmp/data.csv' }),
    ).rejects.toThrow(/upload needs/);
  });

  it('decodes __base64 content into real bytes before constructing the File', async () => {
    // Simulate what the daemon produces: base64-encoded bytes + __base64 sentinel.
    // jsdom supports File and DataTransfer inconsistently across versions — mock DataTransfer so
    // we can assert on what bytes the File actually received without a real browser.
    const originalDT = (global as Record<string, unknown>)['DataTransfer'];
    let capturedFile: File | undefined;
    class FakeDataTransfer {
      files = { length: 1 };
      items = {
        add(f: File) {
          capturedFile = f;
        },
      };
    }
    (global as Record<string, unknown>)['DataTransfer'] = FakeDataTransfer;
    try {
      const el = fileInput();
      // "hello" base64-encoded is "aGVsbG8="
      const base64Content = btoa('hello');
      const err: unknown = await executeAction(refs.refFor(el), 'upload', {
        content: base64Content,
        name: 'greeting.txt',
        type: 'text/plain',
        __base64: true,
      }).catch((e: unknown) => e);

      // The only error we expect is jsdom's FileList assignment — not an assertUploadArgs refusal
      // and not a "wrong bytes" problem. If capturedFile was set, the bytes arrived correctly.
      if (capturedFile !== undefined) {
        // File was constructed — verify the text round-trips
        const text = await capturedFile.text();
        expect(text).toBe('hello');
        expect(capturedFile.name).toBe('greeting.txt');
        expect(capturedFile.type).toBe('text/plain');
      } else {
        // jsdom didn't support full File construction — at minimum confirm no guard refusal
        expect(String(err)).not.toMatch(/upload needs/);
      }
    } finally {
      (global as Record<string, unknown>)['DataTransfer'] = originalDT;
    }
  });

  it('REFUSES an upload with no arguments at all', async () => {
    const el = fileInput();
    await expect(executeAction(refs.refFor(el), 'upload', {})).rejects.toThrow(/content/);
  });

  /**
   * jsdom has no `DataTransfer` and no constructible `FileList`, so the dispatch itself cannot run
   * here — the e2e battery drives a real upload. What these pin is the only thing this guard
   * governs: a well-formed call must reach the dispatch instead of being refused.
   */
  const refusedFor = async (args: Record<string, unknown>): Promise<string> => {
    const el = fileInput();
    const err: unknown = await executeAction(refs.refFor(el), 'upload', args).catch(
      (e: unknown) => e,
    );
    return String(err);
  };

  it('still uploads the file it WAS given', async () => {
    expect(
      await refusedFor({ name: 'pitch.pdf', content: 'hello', type: 'application/pdf' }),
    ).not.toMatch(/upload needs/);
  });

  it('still allows the documented name-only call, whose placeholder body is not a surprise', async () => {
    // Documented as `{ name, content?, type? }`: a caller that names the file and omits the body
    // knows it did. Only a DROPPED key manufactures a file the caller believes it supplied.
    expect(await refusedFor({ name: 'pitch.mp4', type: 'video/mp4' })).not.toMatch(/upload needs/);
  });

  it('does not mistake the generic action arguments for a dropped key', async () => {
    expect(await refusedFor({ name: 'x.txt', confirmDangerous: true })).not.toMatch(/upload needs/);
  });
});

/**
 * The destructive-action guard classifies the ELEMENT, never the form around it.
 *
 * The context string used to include `el.closest('form')?.textContent`, so the whole form's rendered
 * text decided the verdict for every control inside it. Any CRUD form with per-row "Remove" buttons
 * made its own Save button read as destructive — intermittently, because it depended on whether the
 * rows had rendered yet. The field report's answer was to pass confirmDangerous:true on every click,
 * which is the real cost: a guard that fires on everything is a guard that gets switched off.
 */
describe('destructive-action guard reads the element, not the form around it', () => {
  it('does not block a harmless submit because a sibling row says "Delete"', async () => {
    document.body.innerHTML = `
      <form action="/settings">
        <ul><li>Row one <button type="button">Delete</button></li></ul>
        <button type="submit" id="save">Save changes</button>
      </form>`;
    const save = document.getElementById('save') as HTMLButtonElement;
    await expect(executeAction(refs.refFor(save), 'click')).resolves.toBeDefined();
  });

  it('does not block a Payment option — selecting a document type is not a payment', async () => {
    // Radix Select (and most custom selects) render choices as role=option, not a native <option>.
    document.body.innerHTML = '<div role="option" id="pay">Payment</div>';
    const pay = document.getElementById('pay') as HTMLElement;
    await expect(executeAction(refs.refFor(pay), 'click')).resolves.toBeDefined();
  });

  it('does not block Log out, which is a reversible auth flow', async () => {
    document.body.innerHTML = '<button role="menuitem" id="out">Log out</button>';
    const out = document.getElementById('out') as HTMLButtonElement;
    await expect(executeAction(refs.refFor(out), 'click')).resolves.toBeDefined();
  });

  it('still blocks the row button that IS destructive', async () => {
    document.body.innerHTML = `
      <form action="/settings">
        <button type="button" id="del">Delete</button>
        <button type="submit">Save changes</button>
      </form>`;
    const del = document.getElementById('del') as HTMLButtonElement;
    await expect(executeAction(refs.refFor(del), 'click')).rejects.toThrow(/confirmDangerous/);
  });
});
