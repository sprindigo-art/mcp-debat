import { SessionManager } from '../engine/sessions.js';
import { advanceDebate } from '../engine/debate.js';
import { saveConclusions } from '../engine/notebook.js';
import { getSessionCost } from '../engine/cost.js';
import { executeCommand, formatObservation } from '../engine/executor.js';
import { randomUUID } from 'crypto';

export default {
  definition: {
    name: 'mcp_respond',
    description: 'Inject content into active debate (info/critique/correct/evidence/question/decision) AND control flow (continue/synthesize/close/retry). Each continue triggers the NEXT model to speak (model-by-model, max 120s per call).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Active debate session ID' },
        type: {
          type: 'string',
          enum: ['info', 'critique', 'correct', 'redirect', 'evidence', 'question', 'decision'],
          description: 'Type of host intervention'
        },
        response: { type: 'string', description: 'Content of intervention' },
        action: {
          type: 'string',
          enum: ['continue', 'synthesize', 'close', 'retry', 'sync_runbook'],
          description: 'Flow control action (required)'
        },
        client_id: { type: 'string', description: 'Client instance ID for session ownership lock' },
        command: { type: 'string', description: 'Shell command to execute on server (host-injected). Result injected as tool_observation.' }
      },
      required: ['session_id', 'action']
    }
  },

  async execute(params) {
    const { session_id, type, response, action, client_id } = params;
    const session = SessionManager.get(session_id);
    if (!session) return { error: 'Session not found', session_id };

    if (session.owner_client && (!client_id || session.owner_client !== client_id)) {
      return { error: 'Session locked — owned by another client. Use mcp_sessions({action:"get"}) for read-only access.', session_id };
    }

    if (type && response) {
      if (!session.hostInterventions) session.hostInterventions = [];
      session.hostInterventions.push({ type, response, timestamp: new Date().toISOString() });
      SessionManager.save(session);
    }

    if (params.command) {
      const cmdReq = {
        id: randomUUID(), requested_by: 'HOST', tool: 'bash',
        command: params.command, reason: response || 'Host command',
        timeout: 30000, requested_at: new Date().toISOString()
      };
      const cmdResult = await executeCommand(cmdReq);
      const observation = formatObservation(cmdReq, cmdResult);
      SessionManager.addResponse(session, 'tool_observations', 'SYSTEM', {
        content: observation, tokens: { input: 0, output: 0, thinking: 0 }, command_result: cmdResult
      });
      SessionManager.save(session);
      return { session_id, command_result: cmdResult, status: 'command_executed', message: 'Host command executed. Result in transcript.' };
    }

    switch (action) {
      case 'continue':
        return advanceDebate(session);

      case 'synthesize':
        return advanceDebate(session, { forceSynthesis: true });

      case 'close':
        session.status = 'closed';
        if (session.synthesis?.content) {
          const confMatch = session.synthesis.content.match(/recommendation[:\s]*(.*?)(?:\n|$)/i);
          if (confMatch) session.conclusions.push(confMatch[1].trim());
          const actionMatch = session.synthesis.content.match(/action.items?[:\s]*([\s\S]*?)(?:\n\n|$)/i);
          if (actionMatch) session.conclusions.push(actionMatch[1].trim());
        }
        const saved = saveConclusions(session);
        SessionManager.save(session);
        return {
          session_id,
          status: 'closed',
          conclusions: session.conclusions,
          conclusions_saved: !!saved,
          cost: getSessionCost(session_id),
          message: 'Debate closed. Conclusions saved to memory/conclusions.json.'
        };

      case 'retry':
        if (session.roundNumber >= session.maxRounds) {
          return { session_id, error: `Max rounds (${session.maxRounds}) reached. Use action:"close" or increase rounds.`, status: 'max_rounds_reached' };
        }
        session.currentPhase = 'challenge';
        session.currentModelIndex = 0;
        session.roundNumber++;
        SessionManager.save(session);
        return advanceDebate(session);

      case 'sync_runbook':
        return { status: 'deprecated', message: 'Runbook sync is now handled automatically via PostToolUse hook (hook_sync_debat.js). No manual sync needed.' };

      default:
        return { error: `Unknown action: ${action}` };
    }
  }
};
