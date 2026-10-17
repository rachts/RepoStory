export function normalizePath(path: string): string { return path.replaceAll("\\", "/").replace(/^\.\//, ""); }
export function quoteLabel(value: string): string { return value.replace(/["`\n\r\[\]{}<>|]/g, " ").replace(/\s+/g, " ").trim(); }
export function truncate(text: string, max: number): string { return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`; }
export function lines(text: string): string[] { return text.replace(/\r\n?/g, "\n").split("\n"); }
