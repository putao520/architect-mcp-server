#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadEnv } from './env.mjs';
import { initTreeSitter } from './parser.mjs';
import { registerTools } from './spawner.mjs';

const env = loadEnv();
const server = new McpServer({ name: 'architect-tools', version: '0.3.0' });

registerTools(server, env);

async function main() {
  await initTreeSitter();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('Architect MCP Server fatal:', err);
  process.exit(1);
});
