import { getAllProviders } from '../providers/index.js';
import { getSystemPrompt } from '../engine/styles.js';

export default {
  definition: {
    name: 'mcp_quick',
    description: 'Quick parallel opinions from all models — no rounds, no debate phases. Good for fast cross-checks and simple questions.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to ask all models' },
        context: { type: 'string', description: 'Additional context' }
      },
      required: ['question']
    }
  },

  async execute(params) {
    const { question, context } = params;
    const providers = getAllProviders();
    const userPrompt = context ? `${question}\n\nContext:\n${context}` : question;

    const results = await Promise.allSettled(
      providers.map(async (provider) => {
        const start = Date.now();
        const systemPrompt = getSystemPrompt('freeform', provider.id);
        try {
          const result = await provider.chat([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]);
          return {
            model: provider.name,
            content: result.content,
            thinking: result.thinking || null,
            confidence: result.confidence || null,
            tokens: result.tokens,
            latency_ms: Date.now() - start,
            cost_usd: result.cost || 0
          };
        } catch (err) {
          return {
            model: provider.name,
            error: err.message,
            latency_ms: Date.now() - start
          };
        }
      })
    );

    const responses = results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message });
    const totalCost = responses.reduce((sum, r) => sum + (r.cost_usd || 0), 0);

    return { responses, total_cost_usd: totalCost, models_responded: responses.filter(r => !r.error).length };
  }
};
