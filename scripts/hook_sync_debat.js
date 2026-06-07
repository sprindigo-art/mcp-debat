#!/usr/bin/env node
/**
 * PostToolUse hook — TARGET-LOCKED runbook sync to MCP Debat server.
 *
 * Triggers ONLY on mcp__mcp-memori__memory_upsert.
 * Extracts RUNBOOK filepath(s) from tool output → calls sync-runbook.sh per file.
 *
 * CONTRACT:
 * - Input: stdin JSON { tool_name, tool_input, tool_response }
 * - Output: exit 0 always (never block pipeline)
 * - Side effect: spawns background sync for RUNBOOK files only
 */
import { readFileSync, fstatSync, appendFileSync } from 'fs';
import { execFile } from 'child_process';
import { dirname } from 'path';

const SYNC_SCRIPT = '/home/kali/Desktop/mcp-debat/scripts/sync-runbook.sh';
const LOGFILE = '/tmp/sync-runbook.log';

function log(msg) {
  try {
    appendFileSync(LOGFILE, `[${new Date().toISOString()}] [hook] ${msg}\n`);
  } catch {}
}

function readStdin() {
  try {
    const stat = fstatSync(0);
    if (stat.isCharacterDevice()) return null;
    const raw = readFileSync(0, 'utf8');
    if (!raw || !raw.trim()) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } catch {
    return null;
  }
}

function extractRunbookPaths(input) {
  const paths = [];
  const text = JSON.stringify(input);

  const filepathMatches = text.match(/\/home\/kali\/Desktop\/mcp-memori\/runbooks\/RUNBOOK_[^"\\]+\.md/g);
  if (filepathMatches) {
    for (const fp of filepathMatches) {
      if (!paths.includes(fp)) paths.push(fp);
    }
  }

  if (paths.length === 0) {
    const idMatches = text.match(/RUNBOOK_[^"\\]+\.md/g);
    if (idMatches) {
      for (const id of idMatches) {
        const fullPath = `/home/kali/Desktop/mcp-memori/runbooks/${id}`;
        if (!paths.includes(fullPath)) paths.push(fullPath);
      }
    }
  }

  return paths;
}

try {
  const input = readStdin();
  if (!input) process.exit(0);

  const toolName = input.tool_name || input.tool || '';
  if (!toolName.includes('memory_upsert')) process.exit(0);

  const paths = extractRunbookPaths(input);
  if (paths.length === 0) {
    log(`SKIP: memory_upsert but no RUNBOOK filepath found`);
    process.exit(0);
  }

  for (const filepath of paths) {
    log(`TRIGGER: ${filepath}`);
    execFile(SYNC_SCRIPT, [filepath], { detached: true, stdio: 'ignore' }, () => {});
  }
} catch (err) {
  log(`ERROR: ${err?.message || err}`);
}

process.exit(0);
