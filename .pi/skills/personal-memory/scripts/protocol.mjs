export const SCHEMA_VERSION = 1;

export function successEnvelope(data) {
  return { schemaVersion: SCHEMA_VERSION, ok: true, data };
}

export function errorEnvelope(code, message) {
  return {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    error: { code, message },
  };
}

