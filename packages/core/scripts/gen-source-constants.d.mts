// Types for the generator, mirroring gen-desktop-contract.d.mts.

/** Render the CommonJS module text for a `name → value` record of source constants. */
export function renderSourceConstants(constants: Readonly<Record<string, string>>): string;
