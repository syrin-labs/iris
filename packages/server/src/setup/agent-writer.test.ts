import { describe, expect, it } from 'vitest';
import { AgentAction, planAgentConfigs, type AgentPlanStep } from './agent-configs.js';
import {
  applyAgentPlan,
  applyAgentSkills,
  RETICLE_SKILL,
  type AgentWriterIo,
} from './agent-writer.js';

/** A pretend disk that records what was written. */
function disk(
  seed: Record<string, string> = {},
): AgentWriterIo & { files: Record<string, string>; dirs: string[] } {
  const files = { ...seed };
  const dirs: string[] = [];
  return {
    files,
    dirs,
    exists: (p) =>
      Object.keys(files).some((f) => f === p || f.startsWith(`${p}/`)) || dirs.includes(p),
    readFile: (p) => {
      const v = files[p];
      if (undefined === v) throw new Error(`ENOENT ${p}`);
      return v;
    },
    writeFile: (p, c) => {
      files[p] = c;
    },
    mkdirp: (d) => {
      dirs.push(d);
    },
  };
}

const step = (over: Partial<AgentPlanStep> = {}): AgentPlanStep => ({
  id: 'warp',
  name: 'Warp',
  file: '/home/u/.warp/.mcp.json',
  action: AgentAction.CREATE,
  key: 'mcpServers',
  entry: { command: 'npx', args: ['@reticlehq/server', 'mcp'] },
  why: 'test',
  ...over,
});

describe('writing an agent config', () => {
  it('creates one that did not exist', () => {
    const io = disk();
    const [r] = applyAgentPlan([step()], io);
    expect(r?.action).toBe('created');
    expect(JSON.parse(io.files['/home/u/.warp/.mcp.json'] ?? '{}')).toEqual({
      mcpServers: { reticle: { command: 'npx', args: ['@reticlehq/server', 'mcp'] } },
    });
  });

  // The whole promise: a config file is not ours. Everything but our key survives verbatim.
  it('leaves every other server, and every other key, exactly as it was', () => {
    const existing = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } });
    const io = disk({ '/home/u/.warp/.mcp.json': existing });
    applyAgentPlan([step({ action: AgentAction.MERGE })], io);
    const written = JSON.parse(io.files['/home/u/.warp/.mcp.json'] ?? '{}') as Record<
      string,
      unknown
    >;
    expect(written['theme']).toBe('dark');
    expect((written['mcpServers'] as Record<string, unknown>)['other']).toEqual({ command: 'x' });
    expect((written['mcpServers'] as Record<string, unknown>)['reticle']).toBeDefined();
  });

  it('writes nothing for a step the plan said to skip or leave alone', () => {
    const io = disk();
    const results = applyAgentPlan(
      [
        step({ action: AgentAction.SKIP }),
        step({ action: AgentAction.ALREADY }),
        step({ action: AgentAction.MANUAL }),
      ],
      io,
    );
    expect(Object.keys(io.files)).toHaveLength(0);
    expect(results.map((r) => r.action)).toEqual([
      AgentAction.SKIP,
      AgentAction.ALREADY,
      AgentAction.MANUAL,
    ]);
  });

  it('creates a fresh YAML config rather than editing one', () => {
    const io = disk();
    const [r] = applyAgentPlan(
      [step({ action: AgentAction.CREATE_YAML, file: '/home/u/.continue/config.yaml' })],
      io,
    );
    expect(r?.action).toBe('created');
    expect(io.files['/home/u/.continue/config.yaml']).toContain('name: reticle');
  });

  // One unwritable config on a machine with a dozen agents is not a reason to abandon the rest.
  it('turns a write failure into a manual step and carries on', () => {
    const io = disk();
    const failing: AgentWriterIo = {
      ...io,
      writeFile: (p) => {
        if (p.includes('warp')) throw new Error('EACCES');
        io.writeFile(p, '{}');
      },
    };
    const results = applyAgentPlan(
      [step(), step({ id: 'kiro', name: 'Kiro', file: '/home/u/.kiro/settings/mcp.json' })],
      failing,
    );
    expect(results[0]?.action).toBe(AgentAction.MANUAL);
    expect(results[0]?.why).toContain('EACCES');
    expect(results[1]?.action).toBe('created');
  });

  it('never writes a plan step that names no key', () => {
    const io = disk();
    const [r] = applyAgentPlan([{ ...step(), key: undefined, entry: undefined }], io);
    expect(r?.action).toBe(AgentAction.MANUAL);
    expect(Object.keys(io.files)).toHaveLength(0);
  });
});

describe('the plan and the writer together', () => {
  it('registers with a documented path even when the agent is absent', () => {
    const io = disk();
    const plan = planAgentConfigs({
      home: '/home/u',
      platform: 'darwin',
      exists: io.exists,
      readFile: io.readFile,
    });
    const results = applyAgentPlan(plan, io);
    const zed = results.find((r) => 'zed' === r.id);
    expect(zed?.action).toBe('created');
    // Zed calls them context servers; the wrong key writes a file it silently ignores.
    expect(io.files[zed?.file ?? '']).toContain('context_servers');
  });

  it('writes nothing for a community path nothing on the machine evidences', () => {
    const io = disk();
    const plan = planAgentConfigs({
      home: '/home/u',
      platform: 'darwin',
      exists: io.exists,
      readFile: io.readFile,
    });
    const cline = applyAgentPlan(plan, io).find((r) => 'cline' === r.id);
    expect(cline?.action).toBe(AgentAction.SKIP);
    expect(io.files[cline?.file ?? '']).toBeUndefined();
  });
});

describe('the skill file', () => {
  it('writes it only where the agent is installed', () => {
    const io = disk({ '/home/u/.config/zed/settings.json': '{}' });
    const written = applyAgentSkills(io, { home: '/home/u', platform: 'darwin' });
    expect(written.map((w) => w.id)).toEqual(['zed']);
    expect(io.files['/home/u/.agents/skills/reticle/SKILL.md']).toBe(RETICLE_SKILL);
  });

  // A directory appearing in somebody's home for software they do not have is not inert.
  it('scaffolds nothing for an agent that is absent', () => {
    const io = disk();
    expect(applyAgentSkills(io, { home: '/home/u', platform: 'darwin' })).toEqual([]);
    expect(Object.keys(io.files)).toHaveLength(0);
  });

  it('says the two things that make a verdict real', () => {
    expect(RETICLE_SKILL).toContain('act_and_wait');
    expect(RETICLE_SKILL).toContain('is not a pass');
  });
});
