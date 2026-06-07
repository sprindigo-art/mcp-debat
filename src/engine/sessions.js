import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_DIR = join(__dirname, '..', '..', 'sessions');
const MEMORY_DIR = join(__dirname, '..', '..', 'memory');

const sessions = new Map();

function ensureDirs() {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

export const SessionManager = {
  create({ topic, target, context, style, rounds, models, ownerClient, runbookMode, historyMode, requireFullRunbook }) {
    ensureDirs();
    const id = randomUUID();

    const allModels = ['deepseek', 'gemini', 'mistral', 'anthropic', 'qwen', 'openai'];
    const sessionCount = sessions.size;
    const rotateBy = sessionCount % allModels.length;
    const rotatedModels = [...allModels.slice(rotateBy), ...allModels.slice(0, rotateBy)];
    const modelOrder = models || rotatedModels;

    const session = {
      id,
      topic,
      target: target || null,
      context: context || null,
      originalModelOrder: [...modelOrder],
      style,
      maxRounds: Math.min(rounds || 3, 20),
      roundNumber: 1,
      modelOrder,
      currentPhase: 'briefing',
      currentModelIndex: 0,
      phases: {},
      hostInterventions: [],
      conclusions: [],
      synthesis: null,
      status: 'active',
      owner_client: ownerClient || null,
      runbook_mode: runbookMode || 'summary',
      history_mode: historyMode || 'compact',
      pendingCommands: [],
      require_full_runbook: requireFullRunbook || false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    sessions.set(id, session);
    this.save(session);
    return session;
  },

  get(id) {
    return sessions.get(id) || null;
  },

  save(session) {
    ensureDirs();
    session.updated_at = new Date().toISOString();
    const path = join(SESSIONS_DIR, `${session.id}.json`);
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(session, (k, v) => k.startsWith('_') ? undefined : v, 2));
    renameSync(tmp, path);
  },

  delete(id) {
    sessions.delete(id);
    const path = join(SESSIONS_DIR, `${id}.json`);
    if (existsSync(path)) unlinkSync(path);
  },

  list() {
    return [...sessions.values()].map(s => ({
      id: s.id,
      topic: s.topic,
      target: s.target,
      style: s.style,
      phase: s.currentPhase,
      round: s.roundNumber,
      status: s.status,
      created_at: s.created_at,
      updated_at: s.updated_at
    }));
  },

  loadFromDisk() {
    ensureDirs();
    const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, file), 'utf-8'));
        sessions.set(data.id, data);
      } catch (err) {
        console.error(`[sessions] Failed to load ${file}:`, err.message);
      }
    }
  },

  clearMemory() {
    const conclusionsPath = join(MEMORY_DIR, 'conclusions.json');
    if (existsSync(conclusionsPath)) writeFileSync(conclusionsPath, '[]');
  },

  addResponse(session, phase, model, response) {
    if (!session.phases[phase]) session.phases[phase] = [];
    session.phases[phase].push({ model, ...response, timestamp: new Date().toISOString() });
    this.save(session);
  }
};

SessionManager.prototype = undefined;
