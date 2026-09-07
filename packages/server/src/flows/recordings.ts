import type { FlowExpect } from '@reticlehq/core';

/** One captured agent action, normalized for replay. */
export interface RecordedStep {
  /** ReticleTool.ACT | ReticleTool.ACT_SEQUENCE */
  tool: string;
  /** Normalized args: refs replaced by { by:'testid', value } where resolvable. */
  args: Record<string, unknown>;
  /** false if any ref could not be normalized to a testid (replay only valid in-session). */
  stable: boolean;
  /** Optional post-condition annotation carried into the on-disk flow's expect. */
  expect?: FlowExpect;
}

interface ActiveRecording {
  cursor: number;
  steps: RecordedStep[];
  /** The route the journey began on. See CompiledProgram.startPath. */
  startPath?: string;
}

/** A finished, replayable program compiled from a recording. */
export interface CompiledProgram {
  name: string;
  version: number;
  steps: RecordedStep[];
  /*
   * The route recording STARTED on, so a saved flow can navigate there before step 1.
   *
   * Without it a replay begins wherever the page happens to be, and a first step whose whole
   * consequence is "this navigation fetches" quietly fetches nothing when replay is already on the
   * destination — the flow then fails for a reason that has nothing to do with the app. The human
   * recorder has always captured this; the agent's did not, so agent-recorded flows were replayable
   * only from the page they were recorded on. Observed: a green recording went red on replay purely
   * because it started one route further along.
   */
  startPath?: string;
  /**
   * Pages the recording sat on, in order, consecutive stays collapsed. In-memory only — not written
   * to the flow file. Lets save warn about a backtrack (a journey that cannot replay) without a
   * format change.
   */
  routes?: string[];
}

/**
 * Tracks in-flight recordings (name -> { buffer cursor at record_start, captured steps })
 * and the last compiled program per name (for reticle_replay).
 */
export class RecordingStore {
  readonly #active = new Map<string, ActiveRecording>();
  readonly #compiled = new Map<string, CompiledProgram>();

  start(name: string, cursor: number, startPath?: string): void {
    this.#active.set(name, {
      cursor,
      steps: [],
      ...(startPath === undefined ? {} : { startPath }),
    });
  }

  isRecording(name: string): boolean {
    return this.#active.has(name);
  }

  /**
   * Number of steps captured so far in the named ACTIVE recording (0 if it
   * exists but is empty, undefined if there is no active recording by that name). Lets the annotate
   * compiler target the LAST captured step without exposing the mutable step array.
   */
  stepCount(name: string): number | undefined {
    return this.#active.get(name)?.steps.length;
  }

  /** Append a captured step to every active recording (steps belong to all in-flight spans). */
  capture(step: RecordedStep): void {
    for (const rec of this.#active.values()) rec.steps.push(step);
  }

  /** Returns the active recording (cursor + steps) and clears it, or undefined if not recording. */
  stop(name: string): ActiveRecording | undefined {
    const rec = this.#active.get(name);
    this.#active.delete(name);
    return rec;
  }

  saveCompiled(program: CompiledProgram): void {
    this.#compiled.set(program.name, program);
  }

  getCompiled(name: string): CompiledProgram | undefined {
    return this.#compiled.get(name);
  }

  active(): string[] {
    return [...this.#active.keys()];
  }

  /**
   * Names of recordings that have been STOPPED and compiled.
   *
   * The mirror of `active()`, and needed for the same defaulting: after `reticle_record stop` a
   * recording is no longer active, so resolving "the obvious one" from `active()` finds nothing.
   * Saving it then demanded the exact name back from the caller, which is a thing to remember for
   * no reason when exactly one recording exists.
   */
  compiled(): string[] {
    return [...this.#compiled.keys()];
  }
}
