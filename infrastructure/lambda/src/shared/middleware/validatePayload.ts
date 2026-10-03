import Ajv, { JSONSchemaType, ValidateFunction } from 'ajv';

const ajv = new Ajv({ allErrors: true, coerceTypes: false });
const schemaCache = new Map<string, ValidateFunction>();

export function validatePayload<T>(schema: object, payload: unknown, schemaId?: string): T {
  const cacheKey = schemaId ?? JSON.stringify(schema);
  let validate = schemaCache.get(cacheKey);

  if (!validate) {
    validate = ajv.compile(schema as JSONSchemaType<T>);
    schemaCache.set(cacheKey, validate);
  }

  if (!validate(payload)) {
    const errors = validate.errors
      ?.map((e) => (e.instancePath || '(root)') + ' ' + e.message)
      .join('; ');
    throw Object.assign(
      new Error('Validation failed: ' + (errors ?? 'unknown error')),
      { statusCode: 400, errorCode: 'validation.invalid_payload' },
    );
  }

  return payload as T;
}