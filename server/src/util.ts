// Small helpers shared across the server. Browser-safe: web imports server modules that use these.

/** A plain object (not null, not an array): the check before reading fields of parsed JSON or tool input. */
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A thrown value's message, for logs and user-facing errors. Callers trim or cap it themselves. */
export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Quotes text as one POSIX shell word, always (unlike sandbox/provider.ts's, which leaves safe words bare). */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
