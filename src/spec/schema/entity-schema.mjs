import { specTypeToJsonSchema, jsonSchemaToSpecType } from './type-system.mjs';

export function entityToJsonSchema(entity) {
  const properties = {};
  const required = [];

  for (const field of entity.fields || []) {
    properties[field.name] = specTypeToJsonSchema(field.type, field.constraints);

    if (field.constraints) {
      const constraintTags = field.constraints.split(',').map(t => t.trim()).filter(Boolean);
      const defaultMatch = constraintTags.find(t => /^DEFAULT/i.test(t));
      if (defaultMatch) {
        const val = defaultMatch.replace(/^DEFAULT[:\s]*/i, '');
        properties[field.name].default = isNaN(val) ? val : Number(val);
      }
    }

    if (field.required === true || field.required === 'true') {
      required.push(field.name);
    }
  }

  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: `#/schemas/${entity.name}`,
    title: entity.title || entity.name,
    type: 'object',
    properties,
    additionalProperties: false,
  };

  if (required.length > 0) schema.required = required;

  if (entity.indexes && entity.indexes.length > 0) {
    schema['x-indexes'] = entity.indexes.map(idx => ({
      name: idx.name,
      fields: idx.fields,
      type: idx.type,
      unique: idx.unique || false,
    }));
  }

  return schema;
}

export function jsonSchemaToEntity(schema, name) {
  const fields = [];
  const requiredSet = new Set(schema.required || []);

  if (schema.properties) {
    for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
      const field = {
        name: fieldName,
        type: jsonSchemaToSpecType(fieldSchema),
        required: requiredSet.has(fieldName),
        constraints: buildConstraints(fieldSchema, requiredSet.has(fieldName)),
      };
      fields.push(field);
    }
  }

  return {
    name,
    title: schema.title || name,
    fields,
    indexes: (schema['x-indexes'] || []).map(idx => ({
      name: idx.name,
      fields: idx.fields,
      type: idx.type,
      unique: idx.unique || false,
    })),
  };
}

export function entitiesToJsonSchemas(entities) {
  const definitions = {};

  for (const entity of entities) {
    definitions[entity.name] = entityToJsonSchema(entity);
  }

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'SPEC Entity Schemas',
    type: 'object',
    $defs: definitions,
  };
}

function buildConstraints(fieldSchema, isRequired) {
  const tags = [];
  if (isRequired) tags.push('NOT NULL');
  if (fieldSchema['x-constraint']) tags.push(fieldSchema['x-constraint']);
  if (fieldSchema.default !== undefined) tags.push(`DEFAULT:${fieldSchema.default}`);
  if (fieldSchema.maxLength) tags.push(`LEN:${fieldSchema.maxLength}`);
  return tags.length > 0 ? tags.join(',') : null;
}
