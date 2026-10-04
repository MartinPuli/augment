import type { JSONSchema } from "../contracts";

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(expected: string, v: unknown): boolean {
  const t = typeOf(v);
  if (expected === "number") return t === "number" || t === "integer";
  return expected === t;
}

/**
 * Minimal JSON-schema validation for capability arguments: type, required, enum, minimum/maximum,
 * minLength/maxLength, items, additionalProperties:false. Returns a list of human-readable errors.
 */
export function validateSchema(schema: JSONSchema | undefined, value: unknown, path = "arguments"): string[] {
  if (!schema || typeof schema !== "object") return [];
  const errors: string[] = [];
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(t, value))) {
      errors.push(`${path} must be ${types.join(" or ")} (got ${typeOf(value)})`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (typeof value === "string") {
    const minL = schema.minLength as number | undefined;
    const maxL = schema.maxLength as number | undefined;
    if (typeof minL === "number" && value.length < minL) errors.push(`${path} must have length >= ${minL}`);
    if (typeof maxL === "number" && value.length > maxL) errors.push(`${path} must have length <= ${maxL}`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${path} must match ${schema.pattern}`);
      } catch {
        /* ignore invalid pattern */
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validateSchema(schema.items, item, `${path}[${i}]`)));
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of schema.required ?? []) if (obj[r] === undefined) errors.push(`${path}.${r} is required`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(obj)) {
      if (props[k]) errors.push(...validateSchema(props[k], v, `${path}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${k} is not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
        errors.push(...validateSchema(schema.additionalProperties, v, `${path}.${k}`));
    }
  }
  return errors;
}
