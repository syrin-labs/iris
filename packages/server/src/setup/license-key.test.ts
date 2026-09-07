import { describe, expect, it } from 'vitest';
import {
  gitignoreCoversEnv,
  LicenseWrite,
  writeLicenseKey,
  type LicenseIo,
} from './license-key.js';

const KEY = 'rtl_live_abc123';

function disk(seed: Record<string, string> = {}): LicenseIo & { files: Record<string, string> } {
  const files = { ...seed };
  return {
    files,
    exists: (p) => undefined !== files[p],
    readFile: (p) => files[p] ?? '',
    writeFile: (p, c) => {
      files[p] = c;
    },
  };
}

describe('writing the key', () => {
  it('creates .env when there is none', () => {
    const io = disk();
    const r = writeLicenseKey('/p', KEY, io);
    expect(r.action).toBe(LicenseWrite.WRITTEN);
    expect(io.files['/p/.env']).toContain(`RETICLE_LICENSE_KEY=${KEY}`);
  });

  it('appends without disturbing what is already there', () => {
    const io = disk({ '/p/.env': 'API_URL=http://localhost:8000\n' });
    writeLicenseKey('/p', KEY, io);
    expect(io.files['/p/.env']).toContain('API_URL=http://localhost:8000');
    expect(io.files['/p/.env']).toContain(`RETICLE_LICENSE_KEY=${KEY}`);
  });

  // Two assignments is a file whose meaning depends on which one the parser reads last.
  it('replaces an existing key rather than adding a second line', () => {
    const io = disk({ '/p/.env': `RETICLE_LICENSE_KEY=old\nOTHER=1\n` });
    const r = writeLicenseKey('/p', KEY, io);
    expect(r.action).toBe(LicenseWrite.REPLACED);
    expect((io.files['/p/.env'] ?? '').match(/RETICLE_LICENSE_KEY=/g)).toHaveLength(1);
    expect(io.files['/p/.env']).toContain(KEY);
    expect(io.files['/p/.env']).toContain('OTHER=1');
  });

  it('does nothing when the same key is already there', () => {
    const io = disk({ '/p/.env': `RETICLE_LICENSE_KEY=${KEY}\n`, '/p/.gitignore': '.env\n' });
    expect(writeLicenseKey('/p', KEY, io).action).toBe(LicenseWrite.ALREADY);
  });
});

describe('keeping it out of git', () => {
  // A key committed to git is leaked, and stays leaked after the file is removed.
  it('adds .env to .gitignore when nothing covers it', () => {
    const io = disk({ '/p/.gitignore': 'node_modules\n' });
    const r = writeLicenseKey('/p', KEY, io);
    expect(r.gitignoreUpdated).toBe(true);
    expect(io.files['/p/.gitignore']).toContain('.env');
    expect(io.files['/p/.gitignore']).toContain('node_modules');
  });

  it('creates .gitignore when there is none at all', () => {
    const io = disk();
    writeLicenseKey('/p', KEY, io);
    expect(io.files['/p/.gitignore']).toBe('.env\n');
  });

  it('recognises the forms people actually write', () => {
    for (const line of ['.env', '.env*', '*.env', '/.env', 'node_modules\n.env']) {
      expect(gitignoreCoversEnv(line)).toBe(true);
    }
    expect(gitignoreCoversEnv('node_modules\ndist')).toBe(false);
    // .env.local is a different file and does not cover .env.
    expect(gitignoreCoversEnv('.env.local')).toBe(false);
  });

  it('leaves a .gitignore that already covers it alone', () => {
    const io = disk({ '/p/.gitignore': '.env\n' });
    expect(writeLicenseKey('/p', KEY, io).gitignoreUpdated).toBe(false);
  });
});

describe('never leaking it', () => {
  it('keeps the key out of everything it says', () => {
    const io = disk();
    const r = writeLicenseKey('/p', KEY, io);
    expect(r.message).not.toContain(KEY);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
