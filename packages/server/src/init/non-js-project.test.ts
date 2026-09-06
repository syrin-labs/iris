/**
 * "No package.json found here" is the wrong answer to a Python project.
 *
 * It reads as a wrong-directory error, so the reader goes looking for a directory — which is what an
 * agent on a Streamlit app did, before hunting for a standalone browser bundle to inject by hand.
 * Neither search could have succeeded: the SDK has to be imported by the app's own JS build, and
 * there was no JS build.
 */

import { describe, expect, it } from 'vitest';
import {
  detectNonJsEcosystem,
  detectStreamlitProject,
  noPackageJsonMessage,
  streamlitSetupMessage,
} from './non-js-project.js';

const withFiles =
  (...files: string[]) =>
  (file: string): boolean =>
    files.includes(file);

describe('ecosystem detection', () => {
  it('recognises the common Python markers', () => {
    for (const marker of ['requirements.txt', 'pyproject.toml', 'Pipfile', 'setup.py']) {
      expect(detectNonJsEcosystem(withFiles(marker)), marker).toBe('Python');
    }
  });

  it('names Django specifically, since manage.py is unambiguous', () => {
    expect(detectNonJsEcosystem(withFiles('manage.py'))).toBe('Python (Django)');
  });

  it('recognises the other ecosystems an agent is likely to meet', () => {
    expect(detectNonJsEcosystem(withFiles('Gemfile'))).toBe('Ruby');
    expect(detectNonJsEcosystem(withFiles('go.mod'))).toBe('Go');
    expect(detectNonJsEcosystem(withFiles('composer.json'))).toBe('PHP');
  });

  it('says nothing when nothing says', () => {
    expect(detectNonJsEcosystem(withFiles('README.md'))).toBeUndefined();
  });
});

describe('Streamlit detection', () => {
  const detector = (files: Record<string, string>): boolean =>
    detectStreamlitProject((file) => files[file] ?? null, Object.keys(files));

  it('recognises dependency declarations and direct imports', () => {
    expect(detector({ 'requirements.txt': 'streamlit==1.49.1\n' })).toBe(true);
    expect(detector({ 'pyproject.toml': 'dependencies = ["streamlit>=1.40"]\n' })).toBe(true);
    expect(detector({ 'dashboard.py': 'import streamlit as st\n' })).toBe(true);
  });

  it('does not confuse a similarly named package or prose with a Streamlit app', () => {
    expect(detector({ 'requirements.txt': 'streamlit-option-menu\n' })).toBe(false);
    expect(detector({ 'README.md': 'Run this Streamlit example.' })).toBe(false);
  });

  it('explains why the generic template advice does not apply', () => {
    expect(streamlitSetupMessage()).toMatch(/no served template/i);
    expect(streamlitSetupMessage()).toContain('st.html');
    expect(streamlitSetupMessage()).toMatch(/app document/i);
  });
});

describe('the message', () => {
  it('keeps the directory advice when the project could plausibly be JS', () => {
    const message = noPackageJsonMessage(withFiles('README.md'));
    expect(message).toContain("Run `reticle init` from your app's directory");
  });

  it('names the ecosystem and gives it a way in, rather than a reason it cannot come', () => {
    // This used to explain, correctly and uselessly, that a server-rendered app has no JavaScript
    // build to import the SDK from. Every reader acted on it as a refusal. The SDK loads from a URL
    // in a plain page, so the honest answer is a snippet, not an explanation.
    const message = noPackageJsonMessage(withFiles('pyproject.toml'));
    expect(message).toContain('Python');
    expect(message).toMatch(/script-tag|no build step/i);
  });

  it('does not send a Python developer looking for a directory that cannot help', () => {
    const message = noPackageJsonMessage(withFiles('requirements.txt'));
    expect(message).not.toMatch(/Run `reticle init` from your app's directory/);
  });

  it('does not read as a refusal', () => {
    const message = noPackageJsonMessage(withFiles('requirements.txt'));
    expect(message).toMatch(/not a blocker/i);
  });

  it('still points at a JS front end, because plenty of Python apps have one', () => {
    const message = noPackageJsonMessage(withFiles('manage.py'));
    expect(message).toContain('--app');
    expect(message).toMatch(/frontend/);
  });
});

describe('Flutter, which cannot be helped by any directory', () => {
  it('is recognised by its pubspec', () => {
    expect(detectNonJsEcosystem(withFiles('pubspec.yaml'))).toBe('Flutter');
  });

  it('names the reason Reticle can never instrument it, rather than blaming the manifest', () => {
    const message = noPackageJsonMessage(withFiles('pubspec.yaml'));
    expect(message).toContain('Flutter');
    expect(message).toMatch(/canvas/);
    expect(message).not.toContain('No package.json found here');
  });

  it('does not send a Flutter developer looking for a front end that would not help', () => {
    // Every other ecosystem gets the `--app <dir>` hint, because a Django app with a `frontend/`
    // is an ordinary Reticle install. A Flutter web build has no DOM at any path, so the hint is
    // a wild goose chase rather than a lead.
    expect(noPackageJsonMessage(withFiles('pubspec.yaml'))).not.toContain('--app');
  });
});
