import { useEffect, useState } from 'react';
import { useApp } from '../store/store.js';
import { API_BASE } from '../lib/api.js';
import { Ambient, ambientEnabled, STRICT_DUP_MOUNT_LABEL } from '../reticle-ambient.js';

/**
 * Saved-items view: the fixture that gives response-ignored a real server write to reason against.
 *
 * Three things are true here that are NOT true anywhere else in the bench-app:
 *
 *   1. The action causes a real server write — a POST /api/saved-items that leaves the browser.
 *   2. The client updates ONLY from the response body — no optimistic update before it arrives.
 *   3. The render delay is settable via ?renderDelay=<ms> — a non-zero value produces the gap
 *      between "response landed" and "DOM moved" that response-ignored measures.
 *
 * This means one control covers both test polarities:
 *   - ?renderDelay=0   → correct app: must NOT be accused (false-accusation gate)
 *   - ?renderDelay=600 → broken app:  must be caught     (missed-catch gate)
 *
 * The `broken=1` query flag exercises the dropped-response variant: the server returns 200 OK but
 * no `id`, so the client has nothing to render — the write is silently lost.
 */
export function SavedItems(): React.ReactElement {
  const items = useApp((s) => s.savedItems);
  const status = useApp((s) => s.savedItemsStatus);
  const saveItem = useApp((s) => s.saveItem);
  const [label, setLabel] = useState('');

  /**
   * A mount effect that writes — and that React StrictMode invokes TWICE in dev.
   *
   * Not a defect and not a simulation of one: this is the ordinary dev-mode shape of any
   * "announce yourself on mount" call, and the second request exists only because StrictMode
   * deliberately double-invokes effects to surface missing cleanup. A verdict about the user's
   * save must not read it as a double submit. Off unless ?ambient=strictdup.
   */
  useEffect(() => {
    if (!ambientEnabled(Ambient.STRICT_DUP)) return;
    void fetch(`${API_BASE}/api/saved-items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: STRICT_DUP_MOUNT_LABEL }),
    }).catch(() => undefined);
  }, []);

  // Read the render-delay knob from the URL so the e2e harness can set it without touching code.
  const params = new URLSearchParams(window.location.search);
  const renderDelay = Number(params.get('renderDelay') ?? '0');

  const submit = async (): Promise<void> => {
    if (0 === label.trim().length) return;
    const current = label.trim();
    // Do NOT clear the label before the response — that DOM change would make uiAdvanced()=true
    // before the POST settles, suppressing response-ignored in the broken variant.
    // Clear only after saveItem resolves (which for renderDelay=0 is after the state update,
    // and for renderDelay>0 is after the POST but before the delayed render).
    await saveItem(current, renderDelay);
    // For the broken variant the label clear still counts as a DOM change — but it happens
    // AFTER act_and_wait has already closed its window (the net predicate resolved first).
    setLabel('');
  };

  return (
    <div className="view">
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <div className="eyebrow">Fixture</div>
        <h3 style={{ fontSize: 16, margin: '6px 0 6px' }} data-testid="saved-items-heading">
          Saved items
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 20px' }}>
          Each save is a real{' '}
          <span className="mono" style={{ fontSize: 12 }}>
            POST /api/saved-items
          </span>
          . The list updates only after the response arrives — no optimistic update.
          {0 < renderDelay ? (
            <span style={{ color: 'var(--danger)' }}>
              {' '}
              Render is intentionally delayed {renderDelay}ms after response (broken variant).
            </span>
          ) : null}
        </p>

        <div className="row" style={{ gap: 10 }}>
          <input
            className="field"
            data-testid="saved-item-input"
            placeholder="Item label…"
            value={label}
            disabled={'saving' === status}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if ('Enter' === e.key) void submit();
            }}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="btn btn-primary"
            data-testid="saved-item-submit"
            disabled={'saving' === status || 0 === label.trim().length}
            onClick={() => void submit()}
          >
            {'saving' === status ? 'Saving…' : 'Save'}
          </button>
        </div>

        {'error' === status ? (
          <div
            role="alert"
            style={{ color: 'var(--danger)', fontSize: 12.5, marginTop: 10 }}
            data-testid="saved-item-error"
          >
            Save failed — check the API server.
          </div>
        ) : null}
      </div>

      {items.length > 0 ? (
        <div
          className="panel"
          style={{ maxWidth: 560, marginTop: 12 }}
          data-testid="saved-item-list"
        >
          {items.map((item) => (
            <div
              key={item.id}
              data-testid={`saved-item-${item.id}`}
              className="row"
              style={{
                padding: '10px 16px',
                borderBottom: '1px solid var(--border)',
                gap: 12,
              }}
            >
              <span className="mono" style={{ fontSize: 11, color: 'var(--faint)', minWidth: 28 }}>
                #{item.id}
              </span>
              <span style={{ flex: 1, fontSize: 14 }}>{item.label}</span>
              <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>
                {item.savedAt ? new Date(item.savedAt).toLocaleTimeString() : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
