export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T, E = never>(value: T): Result<T, E> => ({ ok: true, value });
export const err = <E = never>(error: E): Result<never, E> => ({ ok: false, error });
