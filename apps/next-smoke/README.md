# next-smoke — the Next.js integration proof

**Job: integration proof.** Proves `@reticlehq/next` works against a real Next.js 15 / React 19 app: App Router, server actions, RSC, and source mapping through SWC.

- **Runs on** `:3100`, started by `apps/e2e/run-ci.sh`.
- **Gated by** `next-smoke-test`, and used as the target by `visual-test`, `crawl-test`, `nav-smoke-test`, `flow-record-replay-test` and `scroll-find-test`.
- **Pins a session id** (`next-smoke`) because the battery addresses it by name. A real multi-app setup should use the SDK's `SESSION_AUTO` default instead.

Thin is correct here. Its job is "the wiring works on Next", not to be an application.
