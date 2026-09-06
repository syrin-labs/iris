/**
 * The real filesystem, in the shape the agent writer and the approval grants expect.
 *
 * Its own module so the MCP server can reach it without importing `setup-command`, which would pull
 * the whole drive machinery — child processes, dev-server supervision, page probing — into the
 * startup path of the one process whose latency a user experiences as "Reticle is slow to connect".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AgentWriterIo } from './agent-writer.js';

export const agentIo: AgentWriterIo = {
  exists: (path: string): boolean => existsSync(path),
  readFile: (path: string): string => readFileSync(path, 'utf8'),
  writeFile: (path: string, contents: string): void => writeFileSync(path, contents),
  mkdirp: (dir: string): void => {
    mkdirSync(dir, { recursive: true });
  },
};
