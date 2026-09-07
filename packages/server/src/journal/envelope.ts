import { z } from 'zod';
import type { SegmentRollup } from './rollups.js';

/**
 * The expected-envelope model — the OSS statistical engine behind the deviation report. Per-metric
 * running stats (Welford, so we never store every sample) accumulate across runs of the same route;
 * a new segment is compared against them and flagged when a metric runs high. The *math* is open; the
 * fleet-calibrated thresholds are the paid layer (see OSS-VS-SERVER). We only flag INCREASES
 * (slower, more errors, more requests) — a segment doing less than expected is not a regression.
 */

/** Online mean/variance/max for one metric (Welford's algorithm). Immutable: addStat returns a copy. */
interface MetricStats {
  count: number;
  mean: number;
  /** Sum of squared deviations (Welford M2); variance = m2/(count-1). */
  m2: number;
  max: number;
}

export function emptyStats(): MetricStats {
  return { count: 0, mean: 0, m2: 0, max: 0 };
}

export function addStat(stats: MetricStats, x: number): MetricStats {
  const count = stats.count + 1;
  const delta = x - stats.mean;
  const mean = stats.mean + delta / count;
  const m2 = stats.m2 + delta * (x - mean);
  return { count, mean, m2, max: Math.max(stats.max, x) };
}

export function stddev(stats: MetricStats): number {
  return stats.count < 2 ? 0 : Math.sqrt(stats.m2 / (stats.count - 1));
}

/** How many stddevs above the mean `x` sits (0 when there's no spread yet). */
export function zScore(stats: MetricStats, x: number): number {
  const sd = stddev(stats);
  return 0 === sd ? 0 : (x - stats.mean) / sd;
}

/** The metrics an envelope tracks per route. */
const ENVELOPE_METRICS = ['durationMs', 'net', 'netErrors', 'consoleErrors'] as const;
type EnvelopeMetric = (typeof ENVELOPE_METRICS)[number];

export interface RouteEnvelope {
  route: string;
  /** Runs that contributed a sample — below MIN_ENVELOPE_SAMPLES the envelope is too green to judge. */
  samples: number;
  stats: Record<EnvelopeMetric, MetricStats>;
}

/** Below this, an envelope is noise — the deviation report falls back to the causal summary. */
export const MIN_ENVELOPE_SAMPLES = 3;

/** Default flag threshold in stddevs. The number is a placeholder for fleet-calibrated priors. */
const DEFAULT_Z_THRESHOLD = 3;

const MetricStatsSchema = z.object({
  count: z.number(),
  mean: z.number(),
  m2: z.number(),
  max: z.number(),
});

/** Persisted shape of a route envelope. Validated on load; a bad file degrades to no envelope. */
export const RouteEnvelopeSchema = z.object({
  route: z.string(),
  samples: z.number().int().min(0),
  stats: z.object({
    durationMs: MetricStatsSchema,
    net: MetricStatsSchema,
    netErrors: MetricStatsSchema,
    consoleErrors: MetricStatsSchema,
  }),
});

export function emptyEnvelope(route: string): RouteEnvelope {
  return {
    route,
    samples: 0,
    stats: {
      durationMs: emptyStats(),
      net: emptyStats(),
      netErrors: emptyStats(),
      consoleErrors: emptyStats(),
    },
  };
}

function metricValue(segment: SegmentRollup, metric: EnvelopeMetric): number {
  switch (metric) {
    case 'durationMs':
      return segment.durationMs;
    case 'net':
      return segment.net.total;
    case 'netErrors':
      return segment.net.errors;
    case 'consoleErrors':
      return segment.consoleErrors;
  }
}

/** Fold one observed segment into the envelope as a new sample. */
export function addSegmentToEnvelope(
  envelope: RouteEnvelope,
  segment: SegmentRollup,
): RouteEnvelope {
  const stats = { ...envelope.stats };
  for (const metric of ENVELOPE_METRICS) {
    stats[metric] = addStat(stats[metric], metricValue(segment, metric));
  }
  return { route: envelope.route, samples: envelope.samples + 1, stats };
}

/** One metric of one segment running abnormally high against its envelope. */
export interface Deviation {
  route: string;
  metric: EnvelopeMetric;
  observed: number;
  expectedMean: number;
  z: number;
}

/**
 * Compare a segment against its envelope. Returns the metrics running high (z above threshold),
 * ranked most-severe first. Empty when the envelope is too green (< MIN_ENVELOPE_SAMPLES) — the caller
 * falls back to the causal summary in that case.
 */
export function compareSegment(
  envelope: RouteEnvelope,
  segment: SegmentRollup,
  zThreshold: number = DEFAULT_Z_THRESHOLD,
): Deviation[] {
  if (envelope.samples < MIN_ENVELOPE_SAMPLES) return [];
  const deviations: Deviation[] = [];
  for (const metric of ENVELOPE_METRICS) {
    const stats = envelope.stats[metric];
    const observed = metricValue(segment, metric);
    const z = zScore(stats, observed);
    if (z > zThreshold) {
      deviations.push({ route: envelope.route, metric, observed, expectedMean: stats.mean, z });
    }
  }
  return deviations.sort((a, b) => b.z - a.z);
}
