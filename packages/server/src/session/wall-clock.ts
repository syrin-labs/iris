/**
 * The real clock, named once.
 *
 * The logic that needs a clock takes one as an argument so a test can drive it without waiting
 * (CLAUDE.md rule 7). That leaves the production callers each constructing the same pair of
 * closures, which is how two of them end up with different sleep implementations. One export, one
 * place to look.
 */
export const WALL_CLOCK = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
};
