/**
 * Test helper: pick a valid sample value for an OpenAPI query parameter so
 * route-contract tests can enumerate every documented parameter from the
 * generated spec (PLU-1.1).
 */

export interface SpecParam {
  name: string;
  in: string;
  schema?: {
    enum?: string[];
    example?: unknown;
    anyOf?: { example?: unknown }[];
  };
}

export function sampleValue(p: SpecParam): string {
  const s = p.schema;
  if (s?.enum?.length) return String(s.enum[0]);
  if (s?.example !== undefined) return String(s.example);
  return "x";
}
