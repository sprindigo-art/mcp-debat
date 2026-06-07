import { SessionManager } from '../engine/sessions.js';

export default {
  definition: {
    name: 'mcp_sessions',
    description: 'List, get details, or delete debate sessions. Sessions persist to disk and can be resumed anytime.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'delete', 'clear_memory', 'transfer'], description: 'Action to perform' },
        session_id: { type: 'string', description: 'Session ID (required for get/delete/transfer)' },
        client_id: { type: 'string', description: 'Client instance ID for ownership verification' },
        to_client: { type: 'string', description: 'Target client ID for transfer action' },
        confirm: { type: 'boolean', description: 'Required true for clear_memory' }
      },
      required: ['action']
    }
  },

  async execute(params) {
    const { action, session_id, client_id, to_client, confirm } = params;

    function ownerCheck(session) {
      if (session.owner_client && (!client_id || session.owner_client !== client_id)) {
        return { error: `Session owned by "${session.owner_client}" — your client_id "${client_id || 'none'}" does not match. Use transfer to change ownership.`, session_id };
      }
      return null;
    }

    switch (action) {
      case 'list': {
        const all = SessionManager.list();
        if (client_id) {
          const mine = all.filter(s => !s.owner_client || s.owner_client === client_id);
          return { sessions: mine, filtered: true, total_all: all.length };
        }
        return { sessions: all };
      }

      case 'get': {
        if (!session_id) return { error: 'session_id required for get' };
        const session = SessionManager.get(session_id);
        if (!session) return { error: 'Session not found' };
        if (session.owner_client && client_id && session.owner_client !== client_id) {
          return { session_id, topic: session.topic, target: session.target, status: session.status, owner: session.owner_client, access: 'summary_only' };
        }
        return { session };
      }

      case 'delete': {
        if (!session_id) return { error: 'session_id required for delete' };
        const delSession = SessionManager.get(session_id);
        if (!delSession) return { error: 'Session not found' };
        const delCheck = ownerCheck(delSession);
        if (delCheck) return delCheck;
        SessionManager.delete(session_id);
        return { status: 'deleted', session_id };
      }

      case 'transfer': {
        if (!session_id || !to_client) return { error: 'session_id and to_client required for transfer' };
        const transferSession = SessionManager.get(session_id);
        if (!transferSession) return { error: 'Session not found' };
        const transCheck = ownerCheck(transferSession);
        if (transCheck) return transCheck;
        transferSession.owner_client = to_client;
        SessionManager.save(transferSession);
        return { status: 'transferred', session_id, new_owner: to_client };
      }

      case 'clear_memory':
        if (!confirm) return { error: 'clear_memory requires confirm:true — this deletes ALL debate conclusions permanently.' };
        if (!client_id) return { error: 'clear_memory requires client_id for audit trail.' };
        SessionManager.clearMemory();
        return { status: 'memory_cleared', cleared_by: client_id };

      default:
        return { error: `Unknown action: ${action}` };
    }
  }
};
