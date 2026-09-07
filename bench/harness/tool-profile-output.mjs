export function toolProfileFailureReason(record) {
  if ('timeout' === record.reason || record.timed_out) return 'timeout';
  if ('tool_error' === record.reason || 'isError' === record.reason || record.is_error) {
    return 'tool_error';
  }
  if ('rpc_error' === record.reason || record.protocol_error) return 'rpc_error';
  if ('string' === typeof record.reason && record.reason.length > 0) return 'rpc_error';
  return 'unknown';
}

export function toPersistableToolRecord(record) {
  return {
    tool: record.tool,
    latency_ms: record.latency_ms,
    is_error: record.is_error,
    protocol_error: null !== record.protocol_error && undefined !== record.protocol_error,
    timed_out: record.timed_out,
    bytes: record.bytes,
    chars: record.chars,
    tokens_o200k: record.tokens_o200k,
    success: record.success,
  };
}

export function toPersistableToolSummary(summary) {
  return {
    total: summary.total,
    passed: summary.passed,
    failed: summary.failed,
    mean_latency_ms: summary.mean_latency_ms,
    failing_tools: summary.failing_tools.map((r) => ({
      tool: r.tool,
      reason: toolProfileFailureReason(r),
    })),
  };
}

export function buildToolProfileOutput(allFixtureResults, fixtureIds, toolsProfiledPerFixture) {
  const matrix = {};
  for (const fixtureId of fixtureIds) {
    const fixtureData = allFixtureResults[fixtureId];
    if (!fixtureData) continue;
    matrix[fixtureId] = {
      fixtureName: fixtureData.fixtureName,
      tools_profiled: fixtureData.tools_profiled,
      results: fixtureData.results.map(toPersistableToolRecord),
      summary: toPersistableToolSummary(fixtureData.summary),
    };
  }
  const fixtures = Object.keys(matrix);
  const firstFixtureId = fixtures[0];

  return {
    fixtures,
    tools_profiled_per_fixture: toolsProfiledPerFixture,
    matrix,
    results: matrix[firstFixtureId]?.results ?? [],
    summary: matrix[firstFixtureId]?.summary ?? {},
  };
}
