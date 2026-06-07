import { BaseProvider } from './base.js';

export class OpenAIProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.baseURL = cfg.baseURL || 'https://api.openai.com/v1';
  }

  async chat(messages, opts = {}) {
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMsgs = messages.filter(m => m.role !== 'system');

    let inputText = '';
    for (const m of userMsgs) {
      const label = m.role === 'assistant' ? '[YOU]' : '[USER]';
      inputText += `${label}: ${m.content}\n\n`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const resp = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.modelId,
          instructions: systemMsg,
          input: inputText.trim(),
          max_output_tokens: opts.maxTokens || this.maxTokens || 4096,
          reasoning: { effort: 'medium' }
        }),
        signal: controller.signal
      });

      clearTimeout(timer);
      const data = await resp.json();

      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      let content = '';
      let thinkingTokens = 0;

      for (const item of (data.output || [])) {
        if (item.type === 'message') {
          for (const c of (item.content || [])) {
            if (c.type === 'output_text') content += c.text || '';
            else if (c.type === 'text') content += c.text || '';
          }
        }
      }

      const usage = data.usage || {};
      const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;
      const tokens = {
        input: usage.input_tokens || 0,
        output: (usage.output_tokens || 0) - reasoningTokens,
        thinking: reasoningTokens
      };

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
        thinking: reasoningTokens > 0 ? `[${reasoningTokens} reasoning tokens]` : null,
        confidence,
        tokens,
        cost: (tokens.input / 1e6 * 2.50) + ((tokens.output + tokens.thinking) / 1e6 * 10.00)
      };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
}
