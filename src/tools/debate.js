import { SessionManager } from '../engine/sessions.js';
import { runPhase } from '../engine/debate.js';

export default {
  definition: {
    name: 'mcp_debate',
    description: 'Start a new multi-model debate or resume an existing session. 4 AI models debate sequentially (Constructive → Challenge → Closing → Synthesis) to cross-check hacking approaches. Claude (host) opens the debate first and can intervene between models.',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'Question or problem to debate' },
        target: { type: 'string', description: 'Target name — auto-loads runbook from server if available' },
        session_id: { type: 'string', description: 'Resume existing debate session instead of creating new' },
        context: { type: 'string', description: 'Additional context (HTTP response, source code, error log)' },
        style: { type: 'string', enum: ['freeform', 'redteam', 'socratic', 'exploit-review'], description: 'Debate style' },
        rounds: { type: 'number', description: 'Max rounds (default: 3, max: 20)' },
        models: { type: 'array', items: { type: 'string' }, description: 'Override model list' },
        client_id: { type: 'string', description: 'Client instance ID for session ownership lock' },
        runbook_mode: { type: 'string', enum: ['summary', 'full'], description: 'Runbook injection: summary (default, max 8000 chars) or full (max 50000 chars)' },
        history_mode: { type: 'string', enum: ['compact', 'full'], description: 'History per response: compact (1500 chars) or full (no truncation)' },
        executor_mode: { type: 'string', enum: ['safe', 'off'], description: 'Command executor: safe (read-only whitelist) or off (disabled)' },
        require_full_runbook: { type: 'boolean', description: 'If true, server reads entire runbook into transcript before Constructive starts' }
      },
      required: ['topic']
    }
  },

  async execute(params) {
    const { topic, target, session_id, context, style, rounds, models, client_id, runbook_mode, history_mode, require_full_runbook } = params;

    if (session_id) {
      const session = SessionManager.get(session_id);
      if (!session) return { error: 'Session not found', session_id };
      if (topic) session.topic = topic;
      if (context) { session.context = context; session.hostInterventions = session.hostInterventions || []; session.hostInterventions.push({ type: 'info', response: `[Resume context update]: ${context}`, timestamp: new Date().toISOString() }); }
      if (topic || context) SessionManager.save(session);
      return {
        session_id,
        phase: session.currentPhase,
        status: 'resumed',
        message: `Resumed session. Current phase: ${session.currentPhase}. Use mcp_respond({action:"continue"}) to proceed.`
      };
    }

    const session = SessionManager.create({ topic, target, context, style: style || 'freeform', rounds: rounds || 3, models, ownerClient: client_id, runbookMode: runbook_mode || 'summary', historyMode: history_mode || 'compact', requireFullRunbook: require_full_runbook || false });
    const briefing = await runPhase(session, 'briefing');

    return {
      session_id: session.id,
      phase: 'briefing',
      status: 'host_window',
      briefing,
      next_model: session.modelOrder[0],
      message: 'Debate opened. Review briefing, then mcp_respond({action:"continue"}) to start Constructive phase.'
    };
  }
};
