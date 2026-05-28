import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { entityToJsonSchema } from './entity-schema.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export function validateEntityData(entity, data) {
  const schema = entityToJsonSchema(entity);
  return validateAgainstSchema(schema, data);
}

export function validateAgainstSchema(schema, data) {
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return {
    valid,
    errors: valid ? [] : (validate.errors || []).map(e => ({
      field: e.instancePath || e.schemaPath,
      message: e.message,
      value: e.data,
    })),
  };
}

export function validateSpecDataDir(index, dataMap) {
  const results = [];
  for (const doc of index.docs) {
    for (const entity of doc.entities) {
      const data = dataMap[entity.name];
      if (!data) continue;

      const validation = validateEntityData(entity, data);
      results.push({
        entity: entity.name,
        file: doc.fileName,
        valid: validation.valid,
        errors: validation.errors,
      });
    }
  }
  return results;
}
