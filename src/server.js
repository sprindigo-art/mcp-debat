import { createServer } from 'http';
import { getToolDefinitions, executeTool, hasTool } from './tools/index.js';
import { SessionManager } from './engine/sessions.js';
import config from '../config.json' with { type: 'json' };

const PORT = process.env.PORT || config.server.port || 3900;
const AUTH_TOKEN = process.env[config.server.authTokenEnv] || '';
let _lastToolSessionId = null;
const PROTOCOL_VERSION = '2024-11-05';

function jsonRpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function authenticate(req) {
  if (!AUTH_TOKEN) return true;
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${AUTH_TOKEN}`;
}

async function handleJsonRpc(body) {
  const { id, method, params } = body;

  switch (method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-debat', version: '1.0.0' }
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return jsonRpcResponse(id, { tools: getToolDefinitions() });

    case 'tools/call': {
      const { name, arguments: args } = params || {};
      if (!name || !hasTool(name)) {
        return jsonRpcError(id, -32601, `Tool not found: ${name}`);
      }
      try {
        const result = await executeTool(name, args || {});
        // Bug 1 fix: save session_id for _lastResult cleanup (stored in module-level var, not on response)
        if (typeof result === 'object' && result.session_id) _lastToolSessionId = result.session_id;
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }]
        });
      } catch (err) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

const MAX_BODY_SIZE = 1048576;

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY_SIZE) { req.destroy(); reject(new Error('Body too large (max 1MB)')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

export function startServer() {
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if ((req.url === '/health' || req.url === '/mcp-debat/health') && req.method === 'GET') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        version: '1.0.0',
        timestamp: new Date().toISOString()
      }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id'
      });
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    if (!authenticate(req)) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    try {
      let clientDisconnected = false;
      req.on('close', () => { if (!res.writableFinished) clientDisconnected = true; });

      const body = await parseBody(req);
      const result = await handleJsonRpc(body);

      if (result === null) {
        res.writeHead(204);
        res.end();
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify(result));

      // Bug 1 fix: clear _lastResult after response successfully sent (client got it)
      // If client disconnected, _lastResult stays for recovery on next call
      if (!clientDisconnected && _lastToolSessionId) {
        const session = SessionManager.get(_lastToolSessionId);
        if (session) { session._lastResult = null; }
        _lastToolSessionId = null;
      }
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify(jsonRpcError(null, -32700, err.message)));
    }
  });

  const bindAddr = AUTH_TOKEN ? '0.0.0.0' : '127.0.0.1';
  server.listen(PORT, bindAddr, () => {
    console.error(`[mcp-debat] Server listening on ${bindAddr}:${PORT}`);
    console.error(`[mcp-debat] Auth: ${AUTH_TOKEN ? 'enabled' : '⚠️ DISABLED — binding to localhost only for safety'}`);
    console.error(`[mcp-debat] Providers: ${Object.keys(config.providers).filter(k => config.providers[k].enabled).join(', ')}`);
  });

  return server;
}
