/** Stable JSON object ordering for validated JSON-only contract values. */
export function canonicalJson(value: unknown): string {
  function sort(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === 'object') return Object.fromEntries(Object.entries(input)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, sort(child)]));
    return input;
  }
  return JSON.stringify(sort(value));
}
