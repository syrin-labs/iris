import { relative } from 'node:path';
import type { PluginObj, PluginPass, types as BabelTypes } from '@babel/core';
import { DATA_RETICLE_SOURCE_ATTR } from '@reticlehq/core/source-constants';

const SOURCE_ATTR = DATA_RETICLE_SOURCE_ATTR;

interface PluginApi {
  types: typeof BabelTypes;
}

/**
 * Stamps `data-reticle-source="relativeFile:line:col"` on every JSX host element (lowercase
 * tag). @reticlehq/react reads it to map a DOM node back to its source — needed on React 19,
 * which removed `_debugSource`. Intended for dev builds only.
 *
 * Exported with `export =` (CommonJS module.exports) — Babel loads a plugin via `require()` and takes
 * the module object directly, so this ships as a bare `module.exports = fn` with no `__esModule`/`default`
 * interop wrapper (which some bundlers mishandle) and no named exports (which an ESM consumer's static
 * named import cannot see at runtime in a CJS module). The attribute name itself is exported from
 * `@reticlehq/core` as `DATA_RETICLE_SOURCE_ATTR` for anyone who needs it.
 */
function reticleSourcePlugin({ types: t }: PluginApi): PluginObj<PluginPass> {
  return {
    name: 'reticle-source',
    visitor: {
      JSXOpeningElement(path, state: PluginPass) {
        const node = path.node;
        // Host elements only (e.g. <div>, <button>) — skip components (<App />).
        if (node.name.type !== 'JSXIdentifier') return;
        const first = node.name.name[0];
        if (first === undefined || first !== first.toLowerCase()) return;

        const alreadyStamped = node.attributes.some(
          (attr) =>
            'JSXAttribute' === attr.type &&
            'JSXIdentifier' === attr.name.type &&
            attr.name.name === SOURCE_ATTR,
        );
        if (alreadyStamped) return;

        const loc = node.loc;
        if (null === loc || loc === undefined) return;

        const filename = state.filename ?? 'unknown';
        // Forward slashes always. `relative` returns the PLATFORM separator, so on Windows this
        // stamped `src\Foo.tsx:42:8` — the `file:line` the whole product hands back, with a
        // separator that matches neither the repo-relative paths every other Reticle surface emits
        // nor the ones the agent then greps for. Nothing failed loudly; the pointers were just
        // subtly the wrong string on one OS.
        const rel = relative(process.cwd(), filename).replace(/\\/g, '/');
        const value = `${rel}:${String(loc.start.line)}:${String(loc.start.column)}`;

        node.attributes.push(t.jsxAttribute(t.jsxIdentifier(SOURCE_ATTR), t.stringLiteral(value)));
      },
    },
  };
}

export = reticleSourcePlugin;
