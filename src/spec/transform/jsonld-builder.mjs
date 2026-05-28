export function buildJsonLd(code, type) {
  if (type === 'stateDiagram' || code.includes('stateDiagram')) {
    return parseStateDiagram(code);
  }
  return null;
}

function parseStateDiagram(code) {
  const states = new Set();
  const transitions = [];
  let initialState = null;

  const lines = code.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    const initMatch = trimmed.match(/^\[\*\]\s*-->\s*(\w+)/);
    if (initMatch) {
      initialState = initMatch[1];
      states.add(initMatch[1]);
      continue;
    }

    const transMatch = trimmed.match(/^(\w+)\s*-->\s*(\w+)(?::\s*(.+))?/);
    if (transMatch) {
      const from = transMatch[1];
      const to = transMatch[2];
      const on = transMatch[3] || '';
      states.add(from);
      states.add(to);
      transitions.push({ from, to, ...(on && { on }) });
      continue;
    }

    const stateMatch = trimmed.match(/^state\s+"?([^"]+)"?\s+as\s+(\w+)/);
    if (stateMatch) {
      states.add(stateMatch[2]);
    }
  }

  if (states.size === 0) return null;

  const stateList = [...states];
  const terminalStates = stateList.filter(s =>
    !transitions.some(t => t.from === s)
  );

  return {
    '@type': 'StateMachine',
    states: stateList,
    ...(initialState && { initialState }),
    transitions,
    ...(terminalStates.length > 0 && { terminalStates }),
  };
}

export function buildDataModelJsonLd(entityName, fields) {
  return {
    '@type': 'DataModel',
    name: entityName,
    fields: fields.map(f => ({
      name: f.name,
      type: f.type || 'string',
      ...(f.required && { required: true }),
      ...(f.constraints && { constraints: f.constraints }),
    })),
  };
}

export function buildApiJsonLd(method, path, reqSchema, resSchema) {
  return {
    '@type': 'ApiEndpoint',
    method,
    path,
    ...(reqSchema && { request: reqSchema }),
    ...(resSchema && { response: resSchema }),
  };
}