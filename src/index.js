#!/usr/bin/env node

import { startServer } from './server.js';
import { initProviders } from './providers/index.js';
import { SessionManager } from './engine/sessions.js';

async function main() {
  console.error('[mcp-debat] Initializing...');

  await initProviders();
  console.error('[mcp-debat] Providers initialized');

  SessionManager.loadFromDisk();
  console.error(`[mcp-debat] Sessions loaded: ${SessionManager.list().length}`);

  startServer();
}

main().catch(err => {
  console.error('[mcp-debat] Fatal error:', err);
  process.exit(1);
});
