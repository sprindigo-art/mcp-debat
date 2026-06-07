import config from '../../config.json' with { type: 'json' };
import { DeepSeekProvider } from './deepseek.js';
import { GeminiProvider } from './gemini.js';
import { MistralProvider } from './mistral.js';
import { AnthropicProvider } from './anthropic.js';
import { QwenProvider } from './qwen.js';
import { OpenAIProvider } from './openai.js';

const providers = new Map();

const PROVIDER_CLASSES = {
  deepseek: DeepSeekProvider,
  gemini: GeminiProvider,
  mistral: MistralProvider,
  anthropic: AnthropicProvider,
  qwen: QwenProvider,
  openai: OpenAIProvider
};

export async function initProviders() {
  for (const [id, cfg] of Object.entries(config.providers)) {
    if (!cfg.enabled) continue;

    const apiKey = process.env[cfg.apiKeyEnv];
    if (!apiKey) {
      console.error(`[providers] ${id}: API key not found (${cfg.apiKeyEnv})`);
      continue;
    }

    const ProviderClass = PROVIDER_CLASSES[id];
    if (!ProviderClass) {
      console.error(`[providers] ${id}: No provider class found`);
      continue;
    }

    try {
      const provider = new ProviderClass({ id, ...cfg, apiKey });
      providers.set(id, provider);
      console.error(`[providers] ${id}: initialized (${cfg.model})${cfg.jailbreak ? ' [JAILBREAK]' : ''}`);
    } catch (err) {
      console.error(`[providers] ${id}: init failed — ${err.message}`);
    }
  }

  console.error(`[providers] ${providers.size}/${Object.keys(config.providers).length} providers ready`);
}

export function getProvider(id) {
  return providers.get(id) || null;
}

export function getAllProviders() {
  return [...providers.values()];
}

export async function testProvider(provider) {
  const result = await provider.chat([
    { role: 'user', content: 'Reply with exactly: OK' }
  ], { maxTokens: 20, timeout: 15000 });
  if (!result.content) throw new Error('Empty response');
  return true;
}
