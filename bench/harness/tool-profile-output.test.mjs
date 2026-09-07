import { describe, expect, it } from 'vitest';
import { buildToolProfileOutput, toPersistableToolRecord } from './tool-profile-output.mjs';

describe('tool profile output', () => {
  it('drops volatile previews and per-run error text from persisted records', () => {
    const record = toPersistableToolRecord({
      tool: 'reticle_sessions',
      latency_ms: 12,
      is_error: false,
      protocol_error: 'ENOENT: /Users/Alice/project/.reticle/runs/session-abc123.json',
      timed_out: false,
      bytes: 250,
      chars: 120,
      tokens_o200k: 36,
      success: false,
      text_preview:
        '{"sessionId":"session-abc123","projectRoot":"/Users/Alice/project","path":"C:\\\\Users\\\\Alice\\\\project"}',
    });

    expect(record).toEqual({
      tool: 'reticle_sessions',
      latency_ms: 12,
      is_error: false,
      protocol_error: true,
      timed_out: false,
      bytes: 250,
      chars: 120,
      tokens_o200k: 36,
      success: false,
    });
  });

  it('builds commit-safe JSON without run timestamps or raw failure strings', () => {
    const output = buildToolProfileOutput(
      {
        'bench-app': {
          fixtureName: 'Vite + React (Bench App)',
          tools_profiled: 1,
          results: [
            {
              tool: 'reticle_query',
              latency_ms: 5,
              is_error: false,
              protocol_error: '/home/alice/checkout failed for session-xyz',
              timed_out: false,
              bytes: 10,
              chars: 10,
              tokens_o200k: 3,
              success: false,
              text_preview: '/home/alice/checkout session-xyz',
            },
          ],
          summary: {
            total: 1,
            passed: 0,
            failed: 1,
            mean_latency_ms: 5,
            failing_tools: [
              {
                tool: 'reticle_query',
                reason: '/home/alice/checkout failed for session-xyz',
              },
            ],
          },
        },
      },
      ['bench-app'],
      1,
    );

    const persisted = JSON.stringify(output);
    expect(output).not.toHaveProperty('timestamp');
    expect(persisted).not.toContain('text_preview');
    expect(persisted).not.toContain('/home/alice');
    expect(persisted).not.toContain('session-xyz');
    expect(output.matrix['bench-app'].summary.failing_tools).toEqual([
      { tool: 'reticle_query', reason: 'rpc_error' },
    ]);
  });
});
