import config from '../../config.json' with { type: 'json' };
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COST_FILE = join(__dirname, '..', '..', 'memory', 'costs.json');

let dailyCost = { date: null, total: 0, perModel: {} };
const sessionCosts = new Map();

function loadCosts() {
  try {
    if (existsSync(COST_FILE)) {
      const data = JSON.parse(readFileSync(COST_FILE, 'utf-8'));
      if (data.daily) dailyCost = data.daily;
      if (data.sessions) {
        for (const [k, v] of Object.entries(data.sessions)) sessionCosts.set(k, v);
      }
    }
  } catch { /* fresh start */ }
}

function saveCosts() {
  try {
    const dir = dirname(COST_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const sessions = {};
    for (const [k, v] of sessionCosts) sessions[k] = v;
    writeFileSync(COST_FILE, JSON.stringify({ daily: dailyCost, sessions }, null, 2));
  } catch { /* non-critical */ }
}

loadCosts();

export function trackCost(provider, tokens) {
  const pricing = config.providers[provider]?.costPer1M;
  if (!pricing || !tokens) return 0;

  const inputCost = (tokens.input || 0) / 1_000_000 * pricing.input;
  const outputCost = (tokens.output || 0) / 1_000_000 * pricing.output;
  const cost = inputCost + outputCost;

  const today = new Date().toISOString().split('T')[0];
  if (dailyCost.date !== today) {
    dailyCost.date = today;
    dailyCost.total = 0;
    dailyCost.perModel = {};
  }
  dailyCost.total += cost;
  dailyCost.perModel[provider] = (dailyCost.perModel[provider] || 0) + cost;

  saveCosts();
  return cost;
}

export function trackSessionCost(sessionId, provider, tokens) {
  const cost = trackCost(provider, tokens);
  if (!sessionCosts.has(sessionId)) sessionCosts.set(sessionId, { total: 0, perModel: {} });
  const sc = sessionCosts.get(sessionId);
  sc.total += cost;
  sc.perModel[provider] = (sc.perModel[provider] || 0) + cost;
  saveCosts();
  return cost;
}

export function getSessionCost(sessionId) {
  return sessionCosts.get(sessionId) || { total: 0, perModel: {} };
}

export function getCostSummary() {
  return {
    daily: { date: dailyCost.date, total_usd: Math.round(dailyCost.total * 10000) / 10000, per_model: dailyCost.perModel },
    active_sessions: sessionCosts.size
  };
}

export function normalizeTokens(provider, usage) {
  if (!usage) return { input: 0, output: 0, thinking: 0 };
  switch (provider) {
    case 'deepseek':
      return { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, thinking: usage.completion_tokens_details?.reasoning_tokens || 0 };
    case 'mistral':
      return { input: usage.prompt_tokens || 0, output: usage.completion_tokens || 0, thinking: 0 };
    case 'gemini':
      return { input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, thinking: usage.thoughtsTokenCount || 0 };
    case 'anthropic':
      return { input: usage.input_tokens || 0, output: usage.output_tokens || 0, thinking: 0 };
    default:
      return { input: 0, output: 0, thinking: 0 };
  }
}
