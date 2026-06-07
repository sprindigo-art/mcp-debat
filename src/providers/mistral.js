import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import { normalizeTokens } from '../engine/cost.js';

export class MistralProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL || 'https://api.mistral.ai/v1',
      timeout: this.timeout
    });
  }

  async chat(messages, opts = {}) {
    const response = await this.client.chat.completions.create({
      model: this.modelId,
      messages,
      max_tokens: opts.maxTokens || this.maxTokens || 1024,
      temperature: 0.7
    });

    const content = response.choices?.[0]?.message?.content || '';
    const tokens = normalizeTokens('mistral', response.usage);

    let confidence = null;
    const confMatch = content.match(/confidence[:\s]*(\d+)/i);
    if (confMatch) confidence = parseInt(confMatch[1]);

    const truncated = this.truncateResponse(content, opts);
    return {
      content: truncated.text,
      response_meta: truncated.meta,
      thinking: null,
      confidence,
      tokens,
      cost: (tokens.input / 1e6 * 0.40) + (tokens.output / 1e6 * 1.20)
    };
  }
}
