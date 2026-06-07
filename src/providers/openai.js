import { BaseProvider } from './base.js';
import config from '../../config.json' with { type: 'json' };

const FALLBACK_ERRORS = [429, 402, 403, 503];

export class OpenAIProvider extends BaseProvider {
  constructor(cfg) {
    super(cfg);
    this.baseURL = cfg.baseURL || 'https://api.openai.com/v1';
    this._usingFallback = false;

    const fb = cfg.fallback;
    if (fb) {
      this.fallbackKey = process.env[fb.apiKeyEnv] || null;
      this.fallbackBaseURL = fb.baseURL;
      this.fallbackModel = fb.model;
      this.fallbackName = fb.name;
      this.fallbackCost = fb.costPer1M || cfg.costPer1M;
    }
  }

  _getEndpoint() {
    if (this._usingFallback && this.fallbackKey) {
      return { url: this.fallbackBaseURL, key: this.fallbackKey, model: this.fallbackModel, name: this.fallbackName };
    }
    return { url: this.baseURL, key: this.apiKey, model: this.modelId, name: this.name };
  }

  async _callAPI(endpoint, systemMsg, inputText, maxTokens, signal) {
    const resp = await fetch(`${endpoint.url}/responses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: endpoint.model,
        instructions: systemMsg,
        input: inputText,
        max_output_tokens: maxTokens,
        reasoning: { effort: 'medium' }
      }),
      signal
    });
    return { resp, status: resp.status };
  }

  async chat(messages, opts = {}) {
    const systemMsg = messages.find(m => m.role === 'system')?.content || '';
    const userMsgs = messages.filter(m => m.role !== 'system');

    let inputText = '';
    for (const m of userMsgs) {
      const label = m.role === 'assistant' ? '[YOU]' : '[USER]';
      inputText += `${label}: ${m.content}\n\n`;
    }
    inputText = inputText.trim();
    const maxTokens = opts.maxTokens || this.maxTokens || 4096;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      let endpoint = this._getEndpoint();
      let { resp, status } = await this._callAPI(endpoint, systemMsg, inputText, maxTokens, controller.signal);

      if (FALLBACK_ERRORS.includes(status) && this.fallbackKey && !this._usingFallback) {
        console.error(`[openai] Primary ${endpoint.name} failed (HTTP ${status}), switching to fallback ${this.fallbackName}`);
        this._usingFallback = true;
        endpoint = this._getEndpoint();
        ({ resp, status } = await this._callAPI(endpoint, systemMsg, inputText, maxTokens, controller.signal));
      }

      if (this._usingFallback && this.apiKey) {
        this._schedulePrimaryCheck();
      }

      clearTimeout(timer);
      const data = await resp.json();

      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      let content = '';
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

      const costInput = (this._usingFallback ? this.fallbackCost : config.providers.openai?.costPer1M) || { input: 2.50, output: 10.00 };
      const truncated = this.truncateResponse(content, opts);
      return {
        content: truncated.text,
        response_meta: truncated.meta,
        thinking: reasoningTokens > 0 ? `[${reasoningTokens} reasoning tokens]` : null,
        confidence,
        tokens,
        cost: (tokens.input / 1e6 * costInput.input) + ((tokens.output + tokens.thinking) / 1e6 * costInput.output),
        provider_used: this._usingFallback ? this.fallbackName : this.name
      };
    } catch (err) {
      clearTimeout(timer);

      if (this.fallbackKey && !this._usingFallback && (err.message?.includes('rate') || err.message?.includes('quota') || err.message?.includes('billing'))) {
        console.error(`[openai] Primary error: ${err.message}, retrying with fallback ${this.fallbackName}`);
        this._usingFallback = true;
        return this.chat(messages, opts);
      }

      throw err;
    }
  }

  _schedulePrimaryCheck() {
    if (this._primaryCheckTimer) return;
    this._primaryCheckTimer = setTimeout(async () => {
      this._primaryCheckTimer = null;
      try {
        const resp = await fetch(`${this.baseURL}/responses`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: this.modelId, input: 'Reply OK', max_output_tokens: 20 }),
          signal: AbortSignal.timeout(10000)
        });
        if (resp.ok) {
          console.error(`[openai] Primary ${this.name} recovered, switching back from fallback`);
          this._usingFallback = false;
        }
      } catch { /* primary still down, stay on fallback */ }
    }, 300000);
  }
}
