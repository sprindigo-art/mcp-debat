import { getAllProviders, testProvider } from '../providers/index.js';
import { SessionManager } from '../engine/sessions.js';
import { getCostSummary } from '../engine/cost.js';

let cachedStatus = null;
let cacheTime = 0;
const CACHE_TTL = 60000;

export default {
  definition: {
    name: 'mcp_health',
    description: 'Server health check — uptime, provider status, active sessions, memory usage, daily cost. Provider ping cached 60s.',
    inputSchema: {
      type: 'object',
      properties: {
        deep: { type: 'boolean', description: 'Force fresh provider ping (default: use 60s cache)' }
      },
    }
  },

  async execute(params = {}) {
    const providers = getAllProviders();
    let providerStatus;

    if (!params.deep && cachedStatus && Date.now() - cacheTime < CACHE_TTL) {
      providerStatus = cachedStatus;
    } else {
      providerStatus = {};
      for (const p of providers) {
        try {
          await testProvider(p);
          providerStatus[p.id] = { status: 'ok', model: p.modelId };
        } catch (err) {
          providerStatus[p.id] = { status: 'error', error: err.message, model: p.modelId };
        }
      }
      cachedStatus = providerStatus;
      cacheTime = Date.now();
    }

    const mem = process.memoryUsage();
    const sessions = SessionManager.list();

    return {
      status: 'ok',
      version: '1.0.0',
      uptime_seconds: Math.floor(process.uptime()),
      providers: providerStatus,
      sessions: {
        active: sessions.filter(s => s.status === 'active').length,
        total: sessions.length
      },
      memory_mb: Math.round(mem.heapUsed / 1024 / 1024),
      cost: getCostSummary(),
      cached: !params.deep && cachedStatus === providerStatus,
      timestamp: new Date().toISOString()
    };
  }
};
