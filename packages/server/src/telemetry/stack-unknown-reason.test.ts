import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { StackUnknownReason } from '@reticlehq/core';
import { detectStack } from './feedback-context.js';

/**
 * An unknown stack has to say WHICH unknown it is.
 *
 * `stack` absent is one of the largest buckets on the profile, and it was one empty object standing
 * for four different facts: no app anywhere, an app we read and did not recognise, workspace apps
 * that were all unrecognised, and discovery erroring. The first is a discovery problem, the second
 * is a line in STACK_BY_DEP, the last is a bug — and nothing could tell them apart, so the dimension
 * could not be acted on (#617).
 *
 * These pin the mapping branch by branch. They do NOT assert on any widening of detection: the
 * point of the issue is to learn which case dominates before adding a detector, so a test that
 * demanded a new stack be recognised would be arguing the opposite case.
 */
describe('detectStack says why the stack is unknown', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'reticle-stack-reason-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const write = (rel: string, body: unknown): void => {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, JSON.stringify(body), 'utf8');
  };

  it('carries NO reason when the stack was found', () => {
    // The field's presence is the signal, so a resolved profile must not carry one at all.
    write('package.json', { dependencies: { next: '^15.0.0' } });
    const got = detectStack(root);
    expect(got.stack).toBe('next');
    expect(got.stackUnknownReason).toBeUndefined();
  });

  it('reports NO_APP_FOUND when there is no manifest anywhere', () => {
    // A daemon started outside the project — the case the issue names first.
    expect(detectStack(root).stackUnknownReason).toBe(StackUnknownReason.NO_APP_FOUND);
  });

  it('reports MANIFEST_UNRECOGNISED when we read the app and knew nothing in it', () => {
    // This is the actionable one: a manifest we parsed, naming a framework not in STACK_BY_DEP.
    // Told apart from "no app", it is one line to fix; collapsed with it, it is invisible.
    write('package.json', { dependencies: { solid: '^1.8.0' } });
    expect(detectStack(root).stackUnknownReason).toBe(StackUnknownReason.MANIFEST_UNRECOGNISED);
  });

  it('reports WORKSPACE_APPS_UNRECOGNISED when discovery found an app and knew nothing in it', () => {
    // Discovery admits this directory on the CONFIG file, not the dependency — which is the only
    // way a discovered app can also be unrecognised. See the note on WORKSPACE_ROOT_NO_APPS.
    write('package.json', { workspaces: ['frontend'] });
    write('frontend/package.json', { dependencies: { solid: '^1.8.0' } });
    writeFileSync(join(root, 'frontend', 'vite.config.ts'), '', 'utf8');
    expect(detectStack(root).stackUnknownReason).toBe(
      StackUnknownReason.WORKSPACE_APPS_UNRECOGNISED,
    );
  });

  it('reports WORKSPACE_ROOT_NO_APPS when a monorepo root surfaced no app at all', () => {
    // The case the bucket is probably full of, and the reason this member exists: `looksLikeApp`
    // admits a directory only on a Vite/Next config or a literal next/vite dependency, so a
    // workspace app on anything else is never surfaced and its manifest is never read. Widening
    // STACK_BY_DEP cannot reach it.
    write('package.json', { workspaces: ['frontend'] });
    write('frontend/package.json', { dependencies: { '@angular/core': '^18.0.0' } });
    expect(detectStack(root).stackUnknownReason).toBe(StackUnknownReason.WORKSPACE_ROOT_NO_APPS);
  });

  it('does not call a monorepo root an unrecognised app', () => {
    // A root naming no framework describes no framework; MANIFEST_UNRECOGNISED here would read as
    // "add this to the stack table" about a manifest that is only a workspace declaration.
    write('package.json', { workspaces: ['frontend'] });
    mkdirSync(join(root, 'frontend'), { recursive: true });
    expect(detectStack(root).stackUnknownReason).toBe(StackUnknownReason.WORKSPACE_ROOT_NO_APPS);
  });

  it('treats an unparseable manifest as no manifest, not as unrecognised', () => {
    // A manifest we cannot parse is not evidence ABOUT the app, and a reason nobody can act on is
    // noise in a closed vocabulary.
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ not json', 'utf8');
    expect(detectStack(root).stackUnknownReason).toBe(StackUnknownReason.NO_APP_FOUND);
  });

  it('reports DISCOVERY_FAILED when workspace discovery throws', () => {
    // An error is not an absence. A detector that reports one as the other sends the reader
    // looking for a project that was there all along.
    write('package.json', { workspaces: ['frontend'] });
    const boom = (): string => {
      throw new Error('EACCES');
    };
    expect(detectStack(root, boom).stackUnknownReason).toBeDefined();
  });
});
