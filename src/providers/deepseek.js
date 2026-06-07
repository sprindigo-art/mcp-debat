import OpenAI from 'openai';
import { BaseProvider } from './base.js';
import { normalizeTokens } from '../engine/cost.js';

export class DeepSeekProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.client = new OpenAI({
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL || 'https://api.deepseek.com',
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

    const choice = response.choices?.[0]?.message;
    let content = choice?.content || '';
    const thinking = choice?.reasoning_content || '';

    if (!content && thinking) {
      content = `[Thinking summary]: ${thinking.substring(0, 1500)}`;
    }

    const tokens = normalizeTokens('deepseek', response.usage);

    let confidence = null;
    const confMatch = content.match(/confidence[:\s]*(\d+)/i);
    if (confMatch) confidence = parseInt(confMatch[1]);

    const truncated = this.truncateResponse(content, opts);
    return {
      content: truncated.text,
      response_meta: truncated.meta,
      thinking: thinking ? thinking.substring(0, 500) : null,
      confidence,
      tokens,
      cost: (tokens.input / 1e6 * 0.435) + (tokens.output / 1e6 * 0.87)
    };
  }
}
