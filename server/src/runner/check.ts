/**
 * Checks that are also types, for what crosses a runner's sockets (protocol.ts, control.ts). Each
 * check takes anything and never throws, so input from the other side is refused, not crashed on.
 */

export type Check<T> = (v: unknown) => v is T;
type Optional<T> = Check<T | undefined> & { readonly optional: true };
export type Of<C> = C extends Check<infer T> ? T : never;
type Fields = Record<string, Check<unknown>>;
type Flat<T> = { [K in keyof T]: T[K] } & {};
type Shape<F extends Fields> = Flat<
	{ [K in keyof F as F[K] extends { optional: true } ? never : K]: Of<F[K]> } &
	{ [K in keyof F as F[K] extends { optional: true } ? K : never]?: Exclude<Of<F[K]>, undefined> }
>;
export const is = <T>(test: (v: unknown) => boolean) => test as Check<T>;
export const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const text = (max: number) => is<string>((v) => typeof v === "string" && v.length > 0 && v.length <= max);
export const string = is<string>((v) => typeof v === "string");
export const boolean = is<boolean>((v) => typeof v === "boolean");
export const integer = is<number>((v) => Number.isSafeInteger(v));
export const count = is<number>((v) => Number.isSafeInteger(v) && (v as number) >= 0);
export const nil = is<null>((v) => v === null);
export const anything = is<unknown>((v) => v !== undefined);
export const oneOf = <const T extends readonly (string | number | boolean)[]>(...values: T) => is<T[number]>((v) => values.includes(v as T[number]));
export const nullable = <T>(check: Check<T>) => is<T | null>((v) => v === null || check(v));
export const optional = <T>(check: Check<T>): Optional<T> => Object.assign(is<T | undefined>((v) => v === undefined || check(v)), { optional: true as const });
export const list = <T>(check: Check<T>, max = Infinity) => is<T[]>((v) => Array.isArray(v) && v.length <= max && v.every(check));
export const either = <A, B>(a: Check<A>, b: Check<B>) => is<A | B>((v) => a(v) || b(v));
export function object<F extends Fields>(fields: F): Check<Shape<F>> {
	return is((v) => plain(v) && Object.keys(v).every((k) => Object.hasOwn(fields, k)) && Object.entries(fields).every(([k, check]) => check(v[k])));
}

/** Undefined for text that is not JSON. */
export function json(data: string): unknown {
	try { return JSON.parse(data); } catch { return undefined; }
}

// For assertions that a wire type is exactly the interface it carries.
export type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export type Assert<T extends true> = T;
