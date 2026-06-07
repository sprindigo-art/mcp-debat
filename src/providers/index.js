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
  // Gemini 2.5 Flash thinking mode uses ~16-30 tokens for thinking before output
  // maxTokens must be high enough to leave room for actual output after thinking
  // Gemini thinking uses ~16-30 tokens, OpenAI reasoning uses ~50+ tokens before output
  const thinkingModels = ['gemini', 'openai'];
  const maxTokens = thinkingModels.includes(provider.id) ? 128 : 20;
  const result = await provider.chat([
    { role: 'user', content: 'Reply with exactly: OK' }
  ], { maxTokens, timeout: 15000 });
  if (!result.content) throw new Error('Empty response');
  return true;
}
