import Anthropic from '@anthropic-ai/sdk';
import { BaseProvider } from './base.js';
import { normalizeTokens } from '../engine/cost.js';

export class AnthropicProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.client = new Anthropic({ apiKey: cfg.apiKey, timeout: this.timeout });
  }

  async chat(messages, opts = {}) {
    const systemMsg = messages.find(m => m.role === 'system');
    const userMsgs = messages.filter(m => m.role !== 'system');

    const apiMessages = [];
    let lastRole = null;
    for (const m of userMsgs) {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      if (role === lastRole && apiMessages.length > 0) {
        apiMessages[apiMessages.length - 1].content += '\n\n' + m.content;
      } else {
        apiMessages.push({ role, content: m.content });
      }
      lastRole = role;
    }

    if (apiMessages.length === 0) {
      apiMessages.push({ role: 'user', content: 'Respond.' });
    }

    if (apiMessages[0].role !== 'user') {
      apiMessages.unshift({ role: 'user', content: 'Begin analysis.' });
    }

    const response = await this.client.messages.create({
      model: this.modelId,
      max_tokens: opts.maxTokens || this.maxTokens || 1024,
      system: systemMsg?.content || '',
      messages: apiMessages,
      temperature: 0.7
    });

    const content = response.content?.map(b => b.text || '').join('') || '';
    const tokens = normalizeTokens('anthropic', response.usage);

    if (this.detectRefusal(content)) {
      const refusalResult = this.handleRefusal(content, messages);
      return { ...refusalResult, tokens, cost: 0 };
    }

    this.refusalCount = 0;

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
      cost: (tokens.input / 1e6 * 15.00) + (tokens.output / 1e6 * 75.00)
    };
  }
}
