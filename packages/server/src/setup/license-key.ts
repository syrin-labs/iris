/**
 * Writing a license key where the CLI will find it, without leaking it.
 *
 * The instructions used to ask an agent to do this by hand in three steps: append to `.env`, check
 * `.gitignore`, confirm. Every one of those is deterministic, and the second is the one that costs
 * something when skipped — a license key committed to git is a leaked credential, and it stays
 * leaked after it is deleted.
 *
 * The key is never printed, never returned, and never put in a result object. The only thing said
 * out loud is that a key was written.
 */

const ENV_FILE = '.env';
const GITIGNORE = '.gitignore';
const ENV_VAR = 'RETICLE_LICENSE_KEY';

export interface LicenseIo {
  readonly exists: (path: string) => boolean;
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, contents: string) => void;
}

export const LicenseWrite = {
  WRITTEN: 'written',
  ALREADY: 'already',
  REPLACED: 'replaced',
} as const;
export type LicenseWrite = (typeof LicenseWrite)[keyof typeof LicenseWrite];

interface LicenseResult {
  readonly action: LicenseWrite;
  /** True when `.gitignore` had to be changed so the key cannot be committed. */
  readonly gitignoreUpdated: boolean;
  /** Safe to print. Never contains the key. */
  readonly message: string;
}

const joinPath = (dir: string, file: string): string => `${dir.replace(/\/$/, '')}/${file}`;

/** Whether `.gitignore` already covers `.env`, allowing for the forms people actually write. */
export function gitignoreCoversEnv(contents: string): boolean {
  return contents
    .split('\n')
    .map((l) => l.trim())
    .some((l) => ENV_FILE === l || '.env*' === l || '*.env' === l || '/.env' === l);
}

/**
 * Put the key in `.env`, and make sure `.env` cannot be committed.
 *
 * An existing assignment is REPLACED rather than appended to: two `RETICLE_LICENSE_KEY` lines is a
 * file where the answer depends on which one the parser reads last, and nobody should have to know
 * which that is.
 */
export function writeLicenseKey(dir: string, key: string, io: LicenseIo): LicenseResult {
  const envPath = joinPath(dir, ENV_FILE);
  const existing = io.exists(envPath) ? io.readFile(envPath) : '';
  const lines = '' === existing ? [] : existing.split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith(`${ENV_VAR}=`));
  const already = -1 !== at && lines[at]?.trim() === `${ENV_VAR}=${key}`;

  let action: LicenseWrite = LicenseWrite.WRITTEN;
  if (already) action = LicenseWrite.ALREADY;
  else if (-1 !== at) {
    lines[at] = `${ENV_VAR}=${key}`;
    action = LicenseWrite.REPLACED;
  } else {
    if (0 < lines.length && '' !== lines[lines.length - 1]) lines.push('');
    lines.push(`${ENV_VAR}=${key}`, '');
  }
  if (LicenseWrite.ALREADY !== action) io.writeFile(envPath, lines.join('\n'));

  // The order matters: a key in git is leaked whether or not the file is later removed.
  const ignorePath = joinPath(dir, GITIGNORE);
  const ignore = io.exists(ignorePath) ? io.readFile(ignorePath) : '';
  let gitignoreUpdated = false;
  if (!gitignoreCoversEnv(ignore)) {
    const next = '' === ignore ? `${ENV_FILE}\n` : `${ignore.replace(/\n*$/, '\n')}${ENV_FILE}\n`;
    io.writeFile(ignorePath, next);
    gitignoreUpdated = true;
  }

  const wrote =
    LicenseWrite.ALREADY === action
      ? `license key already in ${ENV_FILE}`
      : `license key written to ${ENV_FILE}`;
  return {
    action,
    gitignoreUpdated,
    message: gitignoreUpdated ? `${wrote}, and ${ENV_FILE} added to ${GITIGNORE}` : wrote,
  };
}
