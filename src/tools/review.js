import { getAllProviders } from '../providers/index.js';
import { getSystemPrompt } from '../engine/styles.js';

export default {
  definition: {
    name: 'mcp_review',
    description: 'Multi-model code/exploit review. 2-phase simplified flow: all models review sequentially, then synthesizer produces verdict with findings table.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Code/script/exploit to review' },
        focus: {
          type: 'array',
          items: { type: 'string', enum: ['bugs', 'logic', 'security', 'bypass', 'stealth'] },
          description: 'Review focus areas'
        },
        language: { type: 'string', description: 'Programming language hint' }
      },
      required: ['code']
    }
  },

  async execute(params) {
    const { code, focus, language } = params;
    const providers = getAllProviders();
    const focusStr = (focus || ['bugs', 'logic', 'security']).join(', ');
    const langStr = language ? ` (Language: ${language})` : '';

    const reviewPrompt = `Review this code for: ${focusStr}${langStr}.

For each finding, output:
- severity: critical/high/medium/low
- category: ${focusStr}
- description: what's wrong
- suggestion: how to fix
- confidence: 0-100

Code to review:
\`\`\`
${code}
\`\`\`

Output as JSON array of findings.`;

    const reviews = [];

    for (const provider of providers) {
      const systemPrompt = getSystemPrompt('exploit-review', provider.id);
      const start = Date.now();
      try {
        const history = reviews.length > 0
          ? `\n\nPrevious reviewers found:\n${reviews.map(r => `${r.model}: ${r.content.substring(0, 500)}`).join('\n')}\n\nAdd NEW findings or agree/disagree with existing ones.`
          : '';

        const result = await provider.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: reviewPrompt + history }
        ]);

        reviews.push({
          model: provider.name,
          content: result.content,
          tokens: result.tokens,
          latency_ms: Date.now() - start,
          cost_usd: result.cost || 0
        });
      } catch (err) {
        reviews.push({ model: provider.name, error: err.message, latency_ms: Date.now() - start });
      }
    }

    const validReviews = reviews.filter(r => !r.error);
    let verdict = null;

    if (validReviews.length >= 2) {
      const synthIdx = Math.floor(Math.random() * validReviews.length);
      const synthProvider = providers.find(p => p.name === validReviews[synthIdx].model) || providers[0];
      const synthPrompt = `PHASE 2: VERDICT — Compile all reviewer findings into final verdict.

Previous reviews:
${validReviews.map(r => `### ${r.model}:\n${r.content.substring(0, 800)}`).join('\n\n')}

Output REQUIRED:
1. FINDINGS: list ALL unique findings with severity (critical/high/medium/low)
2. AGREEMENT: which findings have 2+ reviewer agreement = HIGH confidence
3. VERDICT: "approve" / "needs-changes" / "critical-issues"
4. TOP_PRIORITY: the single most important finding to fix first`;

      try {
        const synthStart = Date.now();
        const synthResult = await synthProvider.chat([
          { role: 'system', content: getSystemPrompt('exploit-review', synthProvider.id) },
          { role: 'user', content: synthPrompt }
        ]);
        verdict = {
          synthesizer: synthProvider.name,
          content: synthResult.content,
          tokens: synthResult.tokens,
          latency_ms: Date.now() - synthStart,
          cost_usd: synthResult.cost || 0
        };
      } catch (err) {
        verdict = { error: `Verdict synthesis failed: ${err.message}` };
      }
    }

    const totalCost = reviews.reduce((sum, r) => sum + (r.cost_usd || 0), 0) + (verdict?.cost_usd || 0);
    return { reviews, verdict, total_cost_usd: totalCost, models_reviewed: validReviews.length };
  }
};
