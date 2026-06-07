import { execFile } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import config from '../../config.json' with { type: 'json' };

const EXEC_CFG = config.executor || {};
const RUNBOOKS_DIR = '/var/www/mcp/debat/runbooks';
const SERVER_ROOT = '/var/www/mcp/debat';
const MAX_OUTPUT = EXEC_CFG.maxOutputChars || 10000;
const MAX_TIMEOUT = EXEC_CFG.maxTimeout || 30000;
const MAX_CMD_LEN = EXEC_CFG.maxCommandLength || 500;
const MAX_PER_RESPONSE = EXEC_CFG.maxCommandsPerResponse || 3;
const MAX_PER_SESSION = EXEC_CFG.maxCommandsPerSession || 50;

const ALLOWED_PATHS = EXEC_CFG.allowedPaths || [
  '/var/www/mcp/debat/runbooks',
  '/var/www/mcp/debat/src',
  '/var/www/mcp/debat/config.json',
  '/var/www/mcp/debat/memory',
  '/var/www/mcp/debat/sessions',
  '/var/www/mcp/debat/scripts',
  '/var/www/mcp/debat/PLAN.md'
];

const BLOCKED_PATTERNS = [
  /\brm\s+(-[rRf]+|--force|--recursive)/i, /\brm\b.*\//,
  /\bdd\b/, /\bmkfs\b/, /\bkill\b/, /\breboot\b/, /\bshutdown\b/,
  /\bsystemctl\s+(stop|restart|disable)/, /\bchmod\b/, /\bchown\b/,
  /\bcurl\b.*-[dXP]/i, /\bwget\b.*-O/, /\bnc\s+-[el]/,
  /\bpython[23]?\b.*-c/, /\bnode\b.*-e/, /\beval\b/,
  /[>|].*\/etc\//, /\bsudo\b/, /\bsu\b\s/,
  /\bnpm\s+(install|uninstall|publish)/, /\bgit\s+(push|reset|checkout)/,
  /\bbase64\b.*-d.*\|.*\bsh\b/, /`[^`]*`/
];

const ALLOWED_COMMANDS = [
  /^\s*cat\s/, /^\s*head\s/, /^\s*tail\s/, /^\s*grep\s/, /^\s*find\s/,
  /^\s*ls\s/, /^\s*wc\s/, /^\s*file\s/, /^\s*stat\s/, /^\s*diff\s/,
  /^\s*sort\s/, /^\s*uniq\s/, /^\s*cut\s/, /^\s*awk\s/, /^\s*sed\s.*-n/,
  /^\s*jq\s/, /^\s*md5sum\s/, /^\s*sha256sum\s/, /^\s*strings\s/,
  /^\s*git\s+(log|diff|show|status|blame)/
];

function resolveRunbookPath(sessionTarget) {
  if (!sessionTarget) return null;
  const patterns = [
    `RUNBOOK_${sessionTarget}.md`,
    `RUNBOOK_${sessionTarget.replace(/\./g, '_')}.md`
  ];
  for (const p of patterns) {
    const full = join(RUNBOOKS_DIR, p);
    if (existsSync(full)) return full;
  }
  return null;
}

export function readRunbookChunk(sessionTarget, offset = 0, limit = 100) {
  const path = resolveRunbookPath(sessionTarget);
  if (!path) return { error: 'runbook_not_found', target: sessionTarget };

  const lines = readFileSync(path, 'utf-8').split('\n');
  const chunk = lines.slice(offset, offset + limit);
  return {
    source_file: path,
    target: sessionTarget,
    total_lines: lines.length,
    offset,
    limit,
    lines_returned: chunk.length,
    eof: offset + limit >= lines.length,
    content: chunk.join('\n')
  };
}

export function readRunbookSection(sessionTarget, section) {
  const path = resolveRunbookPath(sessionTarget);
  if (!path) return { error: 'runbook_not_found', target: sessionTarget };

  const content = readFileSync(path, 'utf-8');
  const regex = new RegExp(`## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n## |$)`, 'i');
  const match = content.match(regex);
  if (!match) return { error: 'section_not_found', section, target: sessionTarget, source_file: path };

  return {
    section,
    content: match[0],
    chars: match[0].length,
    source_file: path,
    target: sessionTarget
  };
}

export function searchRunbook(sessionTarget, query) {
  const path = resolveRunbookPath(sessionTarget);
  if (!path) return { error: 'runbook_not_found', target: sessionTarget };

  const lines = readFileSync(path, 'utf-8').split('\n');
  const matches = [];
  const lowerQuery = query.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      matches.push({ line: i + 1, content: lines[i] });
    }
  }
  return {
    query,
    matches: matches.slice(0, 50),
    total_matches: matches.length,
    source_file: path,
    target: sessionTarget
  };
}

export function validateCommand(command) {
  if (!command || !command.trim()) return { valid: false, reason: 'Empty command' };
  const cmd = command.trim().replace(/\s+/g, ' ');
  if (cmd.length > MAX_CMD_LEN) return { valid: false, reason: `Command too long (${cmd.length} > ${MAX_CMD_LEN})` };

  for (const p of BLOCKED_PATTERNS) {
    if (p.test(cmd)) return { valid: false, reason: `Blocked pattern: ${p.source.substring(0, 40)}` };
  }

  const segments = cmd.includes('|') ? cmd.split('|').map(s => s.trim()) : [cmd];
  for (const seg of segments) {
    if (!ALLOWED_COMMANDS.some(p => p.test(seg))) {
      return { valid: false, reason: `Not whitelisted: ${seg.substring(0, 50)}` };
    }
  }

  const pathMatches = cmd.match(/\/[^\s'">|;]+/g) || [];
  for (const p of pathMatches) {
    const norm = p.replace(/\/+/g, '/').replace(/\.\.\//g, '');
    if (p.includes('..')) return { valid: false, reason: `Path traversal blocked: ${p}` };
    if (!ALLOWED_PATHS.some(ap => norm.startsWith(ap) || norm === ap)) {
      return { valid: false, reason: `Path not allowed: ${norm}` };
    }
  }

  return { valid: true, sanitized: cmd };
}

function execAsync(command, timeout) {
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', command], {
      timeout: Math.min(timeout || MAX_TIMEOUT, MAX_TIMEOUT),
      maxBuffer: MAX_OUTPUT * 2,
      cwd: SERVER_ROOT,
      env: { PATH: '/usr/bin:/bin', HOME: '/tmp', LANG: 'en_US.UTF-8' }
    }, (error, stdout, stderr) => {
      resolve({ error, stdout: stdout || '', stderr: stderr || '', killed: error?.killed || false });
    });
  });
}

export async function executeCommand(cmdRequest) {
  const validation = validateCommand(cmdRequest.command);
  if (!validation.valid) {
    return {
      id: cmdRequest.id, command: cmdRequest.command,
      status: 'blocked', exit_code: null,
      stdout: '', stderr: `SECURITY: ${validation.reason}`,
      duration_ms: 0, truncated: false,
      executed_at: new Date().toISOString()
    };
  }

  const start = Date.now();
  const { error, stdout, stderr, killed } = await execAsync(validation.sanitized, cmdRequest.timeout);
  const duration_ms = Date.now() - start;
  const isTimeout = killed || /TIMEOUT|ETIMEDOUT/.test(error?.message || '');

  let outText = stdout.substring(0, MAX_OUTPUT);
  let errText = stderr.substring(0, Math.max(0, MAX_OUTPUT - outText.length));
  const truncated = stdout.length > MAX_OUTPUT || stderr.length > (MAX_OUTPUT - outText.length);

  if (truncated) outText += '\n[OUTPUT TRUNCATED]';

  return {
    id: cmdRequest.id, command: validation.sanitized,
    status: isTimeout ? 'timeout' : error ? 'error' : 'completed',
    exit_code: error ? (error.code || error.status || 1) : 0,
    stdout: outText, stderr: errText,
    duration_ms, truncated,
    executed_at: new Date().toISOString()
  };
}

function extractBalancedJson(text, keyword) {
  const idx = text.indexOf(keyword);
  if (idx === -1) return null;

  let start = -1;
  for (let i = idx; i >= 0; i--) {
    if (text[i] === '{') { start = i; break; }
  }
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') { depth--; if (depth === 0) return text.substring(start, i + 1); }
  }
  return null;
}

export function parseToolRequests(content, modelId) {
  if (!content || typeof content !== 'string') return { requests: [], parse_error: null };
  if (!content.includes('tool_requests')) return { requests: [], parse_error: null };

  const jsonBlock = extractBalancedJson(content, 'tool_requests');
  if (!jsonBlock) return { requests: [], parse_error: null };

  try {
    const parsed = JSON.parse(jsonBlock);
    if (!Array.isArray(parsed.tool_requests)) return { requests: [], parse_error: 'tool_requests not array' };

    const VALID_TOOLS = ['bash', 'read_runbook_chunk', 'read_runbook_section', 'search_runbook', 'host_read'];
    const requests = parsed.tool_requests
      .filter(tr => VALID_TOOLS.includes(tr.tool))
      .slice(0, MAX_PER_RESPONSE)
      .map(tr => ({
        id: randomUUID(),
        requested_by: modelId,
        tool: tr.tool,
        command: tr.command || null,
        reason: tr.reason || '',
        offset: tr.offset || 0,
        limit: tr.limit || 100,
        section: tr.section || null,
        query: tr.query || null,
        path: tr.path || null,
        timeout: Math.min(tr.timeout || MAX_TIMEOUT, MAX_TIMEOUT),
        requested_at: new Date().toISOString()
      }));

    return { requests, parse_error: null };
  } catch (e) {
    return { requests: [], parse_error: e.message };
  }
}

export async function processCommand(cmd, sessionTarget) {
  // Fallback: parse section/query from command field if models put JSON there
  if (!cmd.section && cmd.command && cmd.tool === 'read_runbook_section') {
    try { const p = JSON.parse(cmd.command); cmd.section = p.section; } catch { cmd.section = cmd.command; }
  }
  if (!cmd.query && cmd.command && cmd.tool === 'search_runbook') {
    try { const p = JSON.parse(cmd.command); cmd.query = p.query; } catch { cmd.query = cmd.command; }
  }

  switch (cmd.tool) {
    case 'read_runbook_chunk':
      return { id: cmd.id, tool: cmd.tool, status: 'completed', result: readRunbookChunk(sessionTarget, cmd.offset, cmd.limit), duration_ms: 0 };

    case 'read_runbook_section': {
      const section = cmd.section || 'INFO';
      return { id: cmd.id, tool: cmd.tool, status: 'completed', result: readRunbookSection(sessionTarget, section), duration_ms: 0 };
    }

    case 'search_runbook': {
      const query = cmd.query || '';
      return { id: cmd.id, tool: cmd.tool, status: 'completed', result: searchRunbook(sessionTarget, query), duration_ms: 0 };
    }

    case 'bash':
      return { id: cmd.id, tool: cmd.tool, ...(await executeCommand(cmd)) };

    case 'host_read':
      return { id: cmd.id, tool: cmd.tool, status: 'host_action_required', path: cmd.path, reason: cmd.reason, message: 'Host (Janda AI) must read this file from Kali and inject via mcp_respond({type:"evidence"}).' };

    default:
      return { id: cmd.id, tool: cmd.tool, status: 'error', stderr: `Unknown tool: ${cmd.tool}` };
  }
}

export function formatObservation(cmd, result) {
  const status = result.status || 'unknown';
  const exitCode = result.exit_code ?? result.result?.error ?? 'N/A';
  const duration = result.duration_ms || 0;
  const output = result.stdout || result.result?.content || JSON.stringify(result.result || result, null, 2);

  return `[TOOL_OBSERVATION model=${cmd.requested_by} tool=${cmd.tool} status=${status}]\n` +
    `Command: ${cmd.command || cmd.tool}(${cmd.section || cmd.query || `offset=${cmd.offset}`})\n` +
    `Reason: ${cmd.reason}\n` +
    `Exit: ${exitCode} | Duration: ${duration}ms\n` +
    `---\n${typeof output === 'string' ? output : JSON.stringify(output)}\n` +
    (result.stderr ? `STDERR: ${result.stderr}\n` : '') +
    `[/TOOL_OBSERVATION]`;
}

export { MAX_PER_SESSION };
