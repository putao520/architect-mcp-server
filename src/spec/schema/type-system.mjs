const SPEC_TO_JSON_SCHEMA = {
  string:   { type: 'string' },
  text:     { type: 'string', format: 'markdown' },
  integer:  { type: 'integer' },
  int:      { type: 'integer' },
  bigint:   { type: 'integer', format: 'int64' },
  number:   { type: 'number' },
  float:    { type: 'number' },
  decimal:  { type: 'number', format: 'decimal' },
  boolean:  { type: 'boolean' },
  bool:     { type: 'boolean' },
  date:     { type: 'string', format: 'date' },
  datetime: { type: 'string', format: 'date-time' },
  timestamp: { type: 'string', format: 'date-time' },
  time:     { type: 'string', format: 'time' },
  uuid:     { type: 'string', format: 'uuid' },
  email:    { type: 'string', format: 'email' },
  url:      { type: 'string', format: 'uri' },
  uri:      { type: 'string', format: 'uri' },
  json:     { type: 'object', additionalProperties: true },
  jsonb:    { type: 'object', additionalProperties: true },
  blob:     { type: 'string', format: 'binary' },
  bytes:    { type: 'string', format: 'byte' },
};

const SPEC_TO_SQL = {
  string:   'VARCHAR(255)',
  text:     'TEXT',
  integer:  'INTEGER',
  int:      'INTEGER',
  bigint:   'BIGINT',
  number:   'DECIMAL(10,2)',
  float:    'DOUBLE PRECISION',
  decimal:  'DECIMAL(18,6)',
  boolean:  'BOOLEAN',
  bool:     'BOOLEAN',
  date:     'DATE',
  datetime: 'TIMESTAMP',
  timestamp: 'TIMESTAMP',
  time:     'TIME',
  uuid:     'UUID',
  email:    'VARCHAR(320)',
  url:      'VARCHAR(2048)',
  json:     'JSONB',
  jsonb:    'JSONB',
  blob:     'BYTEA',
  bytes:    'BYTEA',
};

export function specTypeToJsonSchema(specType, constraints) {
  if (!specType) return { type: 'string' };

  const lower = specType.toLowerCase().trim();

  const enumMatch = specType.match(/^enum\[(.+)\]$/i);
  if (enumMatch) {
    return { type: 'string', enum: enumMatch[1].split(',').map(v => v.trim()) };
  }

  const arrayMatch = specType.match(/^array<(.+)>$/i);
  if (arrayMatch) {
    return { type: 'array', items: specTypeToJsonSchema(arrayMatch[1]) };
  }

  const nullableMatch = specType.match(/^(.+?)\??$/);
  const baseType = nullableMatch ? nullableMatch[1].trim().toLowerCase() : lower;

  const schema = SPEC_TO_JSON_SCHEMA[baseType] || { type: 'string' };
  const result = { ...schema };

  if (constraints) {
    if (constraints.includes('PK') || constraints.includes('pk')) result['x-constraint'] = 'PRIMARY KEY';
    if (/\d+/.test(constraints)) {
      const len = constraints.match(/\d+/);
      if (len && result.type === 'string') result.maxLength = parseInt(len[0], 10);
    }
    const defaultMatch = constraints.match(/DEFAULT[:\s]+(\S+)/i);
    if (defaultMatch) result.default = defaultMatch[1];
  }

  return result;
}

export function jsonSchemaToSpecType(schema) {
  if (!schema) return 'string';
  if (schema.enum) return `enum[${schema.enum.join(',')}]`;
  if (schema.type === 'array') {
    const item = schema.items ? jsonSchemaToSpecType(schema.items) : 'string';
    return `array<${item}>`;
  }

  const type = schema.type || 'string';
  const format = schema.format;

  if (type === 'string') {
    if (format === 'date-time' || format === 'timestamp') return 'datetime';
    if (format === 'date') return 'date';
    if (format === 'time') return 'time';
    if (format === 'uuid') return 'uuid';
    if (format === 'email') return 'email';
    if (format === 'uri') return 'url';
    if (format === 'binary') return 'blob';
    if (format === 'byte') return 'bytes';
    if (format === 'markdown') return 'text';
    return 'string';
  }
  if (type === 'integer') {
    if (format === 'int64') return 'bigint';
    return 'integer';
  }
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  if (type === 'object') return 'json';

  return 'string';
}

export function specTypeToSql(specType) {
  if (!specType) return 'VARCHAR(255)';
  const lower = specType.toLowerCase().trim();

  const enumMatch = specType.match(/^enum\[(.+)\]$/i);
  if (enumMatch) return `VARCHAR(255) CHECK (...)`;

  const arrayMatch = specType.match(/^array<(.+)>$/i);
  if (arrayMatch) return 'JSONB';

  return SPEC_TO_SQL[lower] || 'VARCHAR(255)';
}

export function isKnownSpecType(specType) {
  if (!specType) return false;
  const lower = specType.toLowerCase().trim();
  if (SPEC_TO_JSON_SCHEMA[lower]) return true;
  if (/^enum\[.+\]$/i.test(specType)) return true;
  if (/^array<.+>$/i.test(specType)) return true;
  if (/^(.+?)\?$/.test(specType)) return isKnownSpecType(specType.replace(/\?$/, ''));
  return false;
}
