import debate from './debate.js';
import respond from './respond.js';
import quick from './quick.js';
import review from './review.js';
import sessions from './sessions.js';
import health from './health.js';

const tools = {
  [debate.definition.name]: debate,
  [respond.definition.name]: respond,
  [quick.definition.name]: quick,
  [review.definition.name]: review,
  [sessions.definition.name]: sessions,
  [health.definition.name]: health,
};

export function getToolDefinitions() {
  return Object.values(tools).map(t => t.definition);
}

export function hasTool(name) {
  return name in tools;
}

export async function executeTool(name, params) {
  return tools[name].execute(params);
}
