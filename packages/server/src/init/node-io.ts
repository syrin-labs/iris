/**
 * The real (Node filesystem) implementation of `InitIo`. Kept separate from the pure runner so
 * `runInit` stays testable with an in-memory IO. Prints to stdout — `init` is a one-shot CLI
 * command, not the MCP stdio transport.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  accessSync,
  constants,
} from 'node:fs';
import { NodePlatform } from '../platform.js';
import { join, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import type { InitIo } from './run.js';
import { windowsShellArg } from './windows-quote.js';

/**
 * `shell: true` ONLY where it earns its keep.
 *
 * It exists so package-manager shims (`pnpm.cmd`, `npx.cmd`) resolve on Windows. On POSIX it buys
 * nothing and costs correctness: under a shell, arguments are re-parsed, so a path containing a
 * space — `/Users/ada/My Projects/app` — silently becomes two arguments and registration fails with
 * no error anyone can read.
 */
function shellOpt(): { shell?: true } {
  return NodePlatform.WINDOWS === process.platform ? { shell: true } : {};
}

/**
 * Under a shell, quote what the shell would otherwise split or interpret. Windows only, where
 * `shell: true` is required (see shellOpt). The rule itself lives in windows-quote.ts as a pure
 * function so it can be tested on every platform — keeping it inside this branch is why it was
 * wrong for as long as it was.
 */
function shellSafe(args: readonly string[]): string[] {
  if (process.platform !== NodePlatform.WINDOWS) return [...args];
  return args.map(windowsShellArg);
}

export function buildNodeIo(cwd: string): InitIo {
  // Project-relative by default; absolute paths (e.g. ~/.cursor/mcp.json) pass through unchanged.
  const abs = (rel: string): string => (isAbsolute(rel) ? rel : join(cwd, rel));
  return {
    readFile(rel) {
      const path = abs(rel);
      if (!existsSync(path)) return null;
      return readFileSync(path, 'utf8');
    },
    writeFile(rel, content) {
      const path = abs(rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content, 'utf8');
    },
    exists(rel) {
      return existsSync(abs(rel));
    },
    homeDir() {
      return homedir();
    },
    cwd() {
      return cwd;
    },
    rootFiles() {
      return readdirSync(cwd).filter((name) => {
        try {
          return statSync(join(cwd, name)).isFile();
        } catch {
          return false;
        }
      });
    },
    listDirs(rel) {
      const path = abs(rel);
      if (!existsSync(path)) return [];
      try {
        return readdirSync(path).filter((name) => statSync(join(path, name)).isDirectory());
      } catch {
        return [];
      }
    },
    listFiles(rel) {
      const path = abs(rel);
      if (!existsSync(path)) return [];
      try {
        return readdirSync(path).filter((name) => !statSync(join(path, name)).isDirectory());
      } catch {
        return [];
      }
    },
    scoped(rel) {
      return buildNodeIo(abs(rel));
    },
    exec(command, args) {
      // Inherit stdio so the install's own progress is visible to the user.
      const result = spawnSync(command, shellSafe(args), { cwd, stdio: 'inherit', ...shellOpt() });
      return 0 === result.status;
    },
    /** One access check, rather than discovering it as an EACCES stack four phases later. */
    canWrite() {
      try {
        accessSync(cwd, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    probe(command, args) {
      // Quiet yes/no check (CLI availability, existing registration). Never throws.
      const result = spawnSync(command, shellSafe(args), { cwd, stdio: 'ignore', ...shellOpt() });
      return 0 === result.status;
    },
    print(line) {
      process.stdout.write(`${line}\n`);
    },
  };
}
