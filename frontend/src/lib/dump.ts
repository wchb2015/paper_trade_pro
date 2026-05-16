// -----------------------------------------------------------------------------
// dump(value): pretty-print any JS value as JSON for logging.
//
//   - Functions are printed as { __type: "function", name, fields? } where
//     `fields` lists any own-enumerable properties hung off the function
//     (skipping the always-present built-ins: length, name, prototype,
//     arguments, caller).
//   - Circular references are replaced with the literal "[Circular]" so the
//     stringify never throws.
//   - BigInt, Symbol, and undefined values get readable sentinels instead of
//     being silently dropped.
//
// Use this anywhere you'd otherwise reach for `JSON.stringify(x, null, 2)` —
// it's safer (no throw on cycles) and won't lose function fields.
// -----------------------------------------------------------------------------

const FN_BUILTINS = new Set([
  "length",
  "name",
  "prototype",
  "arguments",
  "caller",
]);

function describeFunction(fn: Function): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of Object.getOwnPropertyNames(fn)) {
    if (FN_BUILTINS.has(key)) continue;
    fields[key] = (fn as unknown as Record<string, unknown>)[key];
  }
  return {
    __type: "function",
    name: fn.name || "anonymous",
    ...(Object.keys(fields).length > 0 ? { fields } : {}),
  };
}

export function dump(value: unknown, indent: number = 2): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, v) => {
      if (typeof v === "function") return describeFunction(v as Function);
      if (typeof v === "bigint") return `${v.toString()}n`;
      if (typeof v === "symbol") return v.toString();
      if (typeof v === "undefined") return "[undefined]";
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    },
    indent,
  );
}
