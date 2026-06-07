import { getProvider } from '../providers/index.js';
import { getSystemPrompt, getPhasePrompt } from './styles.js';
import { SessionManager } from './sessions.js';
import { trackSessionCost, getSessionCost, getCostSummary } from './cost.js';
import { loadRunbook, summarizeRunbook, loadConclusions } from './notebook.js';
import { detectCollapse, detectRoleDrift, CATFISH_PROMPT } from './collapse.js';
import { parseToolRequests, processCommand, formatObservation, MAX_PER_SESSION } from './executor.js';

const PHASES = ['briefing', 'constructive', 'challenge', 'closing', 'synthesis'];

// GAP 2: Rate limiting — track calls per provider per minute
const rateLimitMap = new Map();
const RATE_LIMIT_PER_MIN = 5;

function checkRateLimit(providerId) {
  const now = Date.now();
  const key = providerId;
  if (!rateLimitMap.has(key)) rateLimitMap.set(key, []);
  const calls = rateLimitMap.get(key).filter(t => now - t < 60000);
  rateLimitMap.set(key, calls);
  if (calls.length >= RATE_LIMIT_PER_MIN) return false;
  calls.push(now);
  return true;
}

// GAP 3: Cost budget — max per session
const MAX_SESSION_COST = 2.0; // $2 per session
const MAX_DAILY_COST = 10.0;  // $10 per day

function checkCostBudget(sessionId) {
  const sessionCost = getSessionCost(sessionId);
  const daily = getCostSummary();
  if (sessionCost.total > MAX_SESSION_COST) return { blocked: true, reason: `Session cost $${sessionCost.total.toFixed(2)} exceeds limit $${MAX_SESSION_COST}` };
  if (daily.daily.total_usd > MAX_DAILY_COST) return { blocked: true, reason: `Daily cost $${daily.daily.total_usd.toFixed(2)} exceeds limit $${MAX_DAILY_COST}` };
  return { blocked: false };
}

function getNextPhase(current) {
  const idx = PHASES.indexOf(current);
  if (idx < 0 || idx >= PHASES.length - 1) return null;
  return PHASES[idx + 1];
}

// GAP 6: Smart injection per-topic (WAF → GAGAL entries, privesc → CREDENTIAL)
function getPhaseContext(session, maxChars = 2000) {
  const briefing = session.briefing || '';
  if (briefing.length <= maxChars) return briefing;

  const topic = (session.topic || '').toLowerCase();
  const lines = briefing.split('\n');
  let result = '';
  const priorityKeywords = [];

  if (topic.includes('waf') || topic.includes('bypass') || topic.includes('filter')) {
    priorityKeywords.push('GAGAL', 'WAF', 'block', 'filter', 'RECON');
  } else if (topic.includes('privesc') || topic.includes('privilege') || topic.includes('root')) {
    priorityKeywords.push('CREDENTIAL', 'NETWORK', 'sudo', 'suid');
  } else if (topic.includes('upload') || topic.includes('webshell')) {
    priorityKeywords.push('upload', 'extension', 'GAGAL', 'RECON');
  }

  // First pass: priority lines
  for (const line of lines) {
    if (priorityKeywords.some(k => line.includes(k)) && result.length + line.length < maxChars * 0.7) {
      result += line + '\n';
    }
  }
  // Second pass: fill remaining with other lines
  for (const line of lines) {
    if (!result.includes(line) && result.length + line.length < maxChars) {
      result += line + '\n';
    }
  }

  return result + '\n[BRIEFING TRUNCATED — full intel in Phase 0]';
}

const ANON_MAP = { deepseek: 'Model A', gemini: 'Model B', mistral: 'Model C', anthropic: 'Model D', qwen: 'Model E', openai: 'Model F' };
const DEANON_MAP = { 'Model A': 'deepseek', 'Model B': 'gemini', 'Model C': 'mistral', 'Model D': 'anthropic', 'Model E': 'qwen', 'Model F': 'openai', 'model a': 'deepseek', 'model b': 'gemini', 'model c': 'mistral', 'model d': 'anthropic', 'model e': 'qwen', 'model f': 'openai' };

function deAnonymize(text) {
  let result = text;
  for (const [label, name] of Object.entries(DEANON_MAP)) {
    result = result.replace(new RegExp(label, 'gi'), name);
  }
  return result;
}

function anonymizeContent(text, modelId) {
  const modelNames = ['deepseek', 'gemini', 'mistral', 'anthropic', 'qwen', 'openai'];
  const labels = ['Model A', 'Model B', 'Model C', 'Model D', 'Model E', 'Model F'];
  let result = text;
  modelNames.forEach((name, i) => {
    if (name !== modelId) {
      result = result.replace(new RegExp(name, 'gi'), labels[i]);
    }
  });
  return result;
}

// Max total context chars to send to any provider — prevents 429/503 from oversized requests
const MAX_CONTEXT_CHARS = 80000; // ~25K tokens — safe for all providers including Mistral (25K tokens/min)

function buildConversationMessages(session, currentModelId, anonymize = false) {
  const messages = [];
  const isFull = session.history_mode === 'full';
  const maxPerResponse = isFull ? 0 : 1500;
  let totalChars = 0;

  const briefingText = getPhaseContext(session);
  messages.push({ role: 'user', content: `[HOST/Claude opens debate]:\n${briefingText}` });
  totalChars += briefingText.length;

  if (session.hostInterventions?.length > 0) {
    for (const h of session.hostInterventions.slice(-3)) {
      const hText = `[HOST/${h.type}]: ${h.response}`;
      messages.push({ role: 'user', content: hText });
      totalChars += hText.length;
    }
  }

  for (const phase of ['tool_observations', 'constructive', 'challenge', 'closing', 'challenge_qa']) {
    const responses = session.phases[phase];
    if (!responses?.length) continue;

    for (const r of responses) {
      if (r.error) continue;
      let text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
      if (maxPerResponse > 0) text = text.substring(0, maxPerResponse);

      // Context budget: skip older entries if over limit
      if (totalChars + text.length > MAX_CONTEXT_CHARS) {
        if (phase === 'tool_observations') {
          // Summarize long runbook chunks instead of dropping
          text = text.substring(0, 500) + '\n[CHUNK TRIMMED — context budget reached]';
        } else {
          continue; // Skip this response to stay in budget
        }
      }

      if (anonymize) text = anonymizeContent(text, currentModelId);
      totalChars += text.length;

      if (r.model === currentModelId) {
        messages.push({ role: 'assistant', content: text });
      } else {
        const label = anonymize ? anonymizeContent(r.model, currentModelId) : r.model;
        messages.push({ role: 'user', content: `[${label}]: ${text}` });
      }
    }
  }

  return messages;
}

// Retry with exponential backoff for 429/503/rate limit errors
const RETRYABLE_PATTERNS = [/429/i, /503/i, /rate.?limit/i, /too many/i, /overloaded/i, /high demand/i, /quota/i, /capacity/i];

function isRetryableError(err) {
  const msg = (err?.message || err?.toString() || '').toLowerCase();
  return RETRYABLE_PATTERNS.some(p => p.test(msg));
}

async function callWithRetry(provider, messages, maxRetries = 3, chatOpts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await provider.chat(messages, chatOpts);
      if (result.refused && result.reframe && !provider.disabled) {
        const reframed = provider.reframeMessages(messages);
        try {
          const retryResult = await provider.chat(reframed, chatOpts);
          if (!retryResult.refused) {
            provider.refusalCount = 0;
            return retryResult;
          }
        } catch { /* reframe retry failed, return original */ }
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = Math.min(3000 * Math.pow(2, attempt), 15000);
        console.error(`[debate] ${provider.id} attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}. Retry in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// handleChallengeQuestions REMOVED — obsolete, replaced by pendingQuestions architecture (Bug 28 fix)

export async function runPhase(session, phase) {
  if (phase === 'briefing') {
    let runbookContent = '';
    let runbookMeta = {};
    if (session.target) {
      const full = loadRunbook(session.target);
      if (full) {
        const mode = session.runbook_mode || 'summary';
        const maxChars = mode === 'full' ? 50000 : 8000;
        runbookContent = full.length <= maxChars ? full : summarizeRunbook(full, maxChars);
        runbookMeta = { runbook_mode: mode, runbook_chars_original: full.length, runbook_chars_injected: runbookContent.length, truncated: full.length > maxChars };
        if (runbookMeta.truncated && mode === 'full') runbookContent += `\n\n[WARNING: runbook truncated from ${full.length} to ${maxChars} chars]`;
      } else {
        runbookContent = '[No runbook found — debate proceeds without target intel]';
        runbookMeta = { runbook_mode: 'none', runbook_chars_original: 0, runbook_chars_injected: 0 };
      }
    }

    let debateMemory = '';
    const pastConclusions = loadConclusions(session.topic);
    if (pastConclusions.length > 0) {
      debateMemory = '\nPREVIOUS CONCLUSIONS (settled):\n' +
        pastConclusions.map(c => `- [${c.created_at?.split('T')[0] || '?'}] ${c.topic}: ${(c.conclusions || []).join('; ')}`).join('\n');
    }

    const opening = [
      `=== CLAUDE (HOST) OPENING STATEMENT ===`,
      `TARGET: ${session.target || 'N/A'}`,
      `TOPIC: ${session.topic}`,
      session.context ? `CONTEXT: ${session.context}` : '',
      runbookContent ? `\nTARGET INTEL:\n${runbookContent}` : '',
      debateMemory,
      `\n=== END BRIEFING ===`
    ].filter(Boolean).join('\n');

    session.briefing = opening;

    // Mandatory runbook ingestion if require_full_runbook
    if (session.require_full_runbook && session.target) {
      // When require_full_runbook is ON, skip briefing runbook injection to avoid DOUBLE context
      // Runbook will be in tool_observations instead (more structured, chunk-by-chunk)
      if (runbookMeta.runbook_chars_injected > 525) {
        // Replace large briefing runbook with pointer — full content comes via tool_observations
        const briefingIdx = session.briefing?.indexOf('\nTARGET INTEL:\n');
        if (briefingIdx > -1) {
          const endIdx = session.briefing.indexOf('\nPREVIOUS CONCLUSIONS', briefingIdx);
          const cutEnd = endIdx > -1 ? endIdx : session.briefing.indexOf('\n=== END BRIEFING ===', briefingIdx);
          if (cutEnd > -1) {
            session.briefing = session.briefing.substring(0, briefingIdx) +
              '\nTARGET INTEL: [Full runbook loaded via TOOL_OBSERVATIONS — ' + runbookMeta.runbook_chars_original + ' chars, see chunks below]\n' +
              session.briefing.substring(cutEnd);
            runbookMeta.briefing_replaced = true;
          }
        }
      }

      const { readRunbookChunk } = await import('./executor.js');
      let offset = 0;
      const limit = 50;
      let eof = false;
      let chunkCount = 0;
      while (!eof) {
        const chunk = readRunbookChunk(session.target, offset, limit);
        if (chunk.error) {
          SessionManager.addResponse(session, 'tool_observations', 'SYSTEM', {
            content: `[RUNBOOK_INGESTION error=${chunk.error}] target=${session.target}`, tokens: { input: 0, output: 0, thinking: 0 }
          });
          break;
        }
        SessionManager.addResponse(session, 'tool_observations', 'SYSTEM', {
          content: `[RUNBOOK_INGESTION chunk=${++chunkCount} offset=${offset} lines=${chunk.lines_returned} total=${chunk.total_lines} eof=${chunk.eof}]\n${chunk.content}`,
          tokens: { input: 0, output: 0, thinking: 0 },
          runbook_chunk: { offset, limit, total_lines: chunk.total_lines, eof: chunk.eof, lines_returned: chunk.lines_returned }
        });
        eof = chunk.eof;
        offset += limit;
      }
      runbookMeta.ingestion = { chunks: chunkCount, total_lines: offset > 0 ? (eof ? offset - limit + (chunkCount > 0 ? 50 : 0) : offset) : 0, eof };
    }

    session.currentPhase = 'constructive';
    session.currentModelIndex = 0;
    SessionManager.save(session);
    return { opening, target: session.target, style: session.style, runbook: runbookMeta };
  }
  return null;
}

export async function advanceDebate(session, opts = {}) {
  const { forceSynthesis } = opts;

  if (session._processing) {
    return { session_id: session.id, error: 'Request already in progress. Wait for current model to finish.', status: 'concurrent_blocked' };
  }
  session._processing = true;

  try {

  // GAP 3: Cost budget check
  const budget = checkCostBudget(session.id);
  if (budget.blocked) {
    session._processing = false;
    return { session_id: session.id, error: budget.reason, status: 'cost_limit_reached' };
  }

  if (forceSynthesis) {
    if (session.currentPhase !== 'closing' && session.currentPhase !== 'synthesis') {
      session.currentPhase = 'closing';
      session.currentModelIndex = 0;
      SessionManager.save(session);
      return {
        session_id: session.id, phase: 'closing', status: 'host_window',
        message: 'Moving to CLOSING first. mcp_respond({action:"continue"}).',
        next_model: session.modelOrder[0]
      };
    }
  }

  if (session.currentPhase === 'synthesis') return runSynthesis(session);

  const phase = session.currentPhase;
  const modelOrder = session.modelOrder;
  const modelIdx = session.currentModelIndex;

  if (modelIdx >= modelOrder.length) {
    // GAP 5: minimum 2 model check
    const phaseResponses = (session.phases[phase] || []).filter(r => !r.error);
    if (phaseResponses.length < 2 && phase !== 'closing') {
      return {
        session_id: session.id, phase, status: 'insufficient_models',
        error: `Only ${phaseResponses.length} model(s) responded in ${phase}. Minimum 2 required.`,
        message: 'Consider retrying with mcp_respond({action:"retry"}) or closing debate.'
      };
    }

    const nextPhase = getNextPhase(phase);
    if (!nextPhase) return runSynthesis(session);

    session.currentPhase = nextPhase;
    session.currentModelIndex = 0;

    if (nextPhase === 'challenge') session.modelOrder = [...session.modelOrder].reverse();
    else if (nextPhase === 'closing') session.modelOrder = [...session.modelOrder].reverse();

    // DOWN check — DISABLED: confidence self-reported unreliable (r=0.024-0.166 per arXiv:2605.00914)
    // Challenge phase selalu dijalankan untuk memastikan critical thinking terjadi

    session._hostWindowStart = Date.now();
    SessionManager.save(session);
    return {
      session_id: session.id, phase: nextPhase, phase_complete: false, status: 'host_window',
      host_window_timeout_ms: 120000,
      message: `Phase ${phase} complete. Next: ${nextPhase}. mcp_respond({action:"continue"}).`,
      next_model: session.modelOrder[0]
    };
  }

  // Process pending Q&A questions FIRST (1 per call — plan Bug 28 compliant)
  if (session.pendingQuestions?.length > 0) {
    const q = session.pendingQuestions.shift();
    const targetProvider = getProvider(q.to);
    if (!targetProvider || targetProvider.disabled) {
      SessionManager.save(session);
      return {
        session_id: session.id, phase, model: q.to,
        qa_answer: { from: q.to, error: `${q.to} not available` },
        pending_qa_remaining: session.pendingQuestions.length,
        status: 'qa_skipped', message: `Q&A: ${q.to} skipped. mcp_respond({action:"continue"}).`
      };
    }
    const systemPrompt = getSystemPrompt(session.style, q.to);
    const start = Date.now();
    try {
      const result = await callWithRetry(targetProvider, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `${q.from} asks: "${q.question}"\nAnswer concisely. Defend with evidence.` }
      ]);
      SessionManager.addResponse(session, 'challenge_qa', q.to, {
        content: `[Answering ${q.from}]: ${result.content}`, tokens: result.tokens
      });
      trackSessionCost(session.id, q.to, result.tokens);
      SessionManager.save(session);
      return {
        session_id: session.id, phase, model: q.to,
        qa_answer: { from: q.to, question: q.question, answer: result.content, latency_ms: Date.now() - start },
        pending_qa_remaining: session.pendingQuestions.length,
        next_model: session.pendingQuestions.length > 0 ? session.pendingQuestions[0].to : modelOrder[modelIdx],
        status: 'qa_answered', message: `Q&A: ${q.to} answered. ${session.pendingQuestions.length} remaining. mcp_respond({action:"continue"}).`
      };
    } catch (err) {
      SessionManager.save(session);
      return {
        session_id: session.id, phase, model: q.to,
        qa_answer: { from: q.to, error: err.message }, status: 'qa_error',
        message: `Q&A: ${q.to} failed. mcp_respond({action:"continue"}).`
      };
    }
  }

  // Process pending COMMANDS (1 per call — FIFO, same pattern as pendingQuestions)
  if (session.pendingCommands?.length > 0) {
    const cmd = session.pendingCommands.shift();
    const cmdResult = await processCommand(cmd, session.target);
    const observation = formatObservation(cmd, cmdResult);

    SessionManager.addResponse(session, 'tool_observations', 'SYSTEM', {
      content: observation,
      tokens: { input: 0, output: 0, thinking: 0 },
      command_result: cmdResult
    });
    SessionManager.save(session);

    return {
      session_id: session.id, phase, model: 'SYSTEM',
      command_result: cmdResult,
      requested_by: cmd.requested_by,
      pending_commands_remaining: session.pendingCommands.length,
      status: cmdResult.status === 'host_action_required' ? 'host_action_required' : 'command_executed',
      message: cmdResult.status === 'host_action_required'
        ? `Host must read ${cmd.path} from Kali and inject via mcp_respond({type:"evidence"}).`
        : `Command ${cmdResult.status}. ${session.pendingCommands.length} remaining. mcp_respond({action:"continue"}).`
    };
  }

  const modelId = modelOrder[modelIdx];
  const provider = getProvider(modelId);

  if (provider?.disabled && provider.disabledAt && Date.now() - provider.disabledAt > 300000) {
    provider.disabled = false;
    provider.errorCount = 0;
  }

  if (!provider || provider.disabled) {
    session.currentModelIndex++;
    SessionManager.save(session);
    return {
      session_id: session.id, phase, model: modelId,
      error: `${modelId} ${provider?.disabled ? 'disabled (circuit breaker)' : 'not available'}`,
      next_model: modelOrder[session.currentModelIndex] || null, status: 'model_skipped'
    };
  }

  // GAP 2: Rate limit check
  if (!checkRateLimit(modelId)) {
    session.currentModelIndex++;
    SessionManager.save(session);
    return {
      session_id: session.id, phase, model: modelId,
      error: `${modelId} rate limited (${RATE_LIMIT_PER_MIN}/min). Try again shortly.`,
      next_model: modelOrder[session.currentModelIndex] || null, status: 'rate_limited'
    };
  }

  let systemPrompt = getSystemPrompt(session.style, modelId);
  if (session.catfishActive && session.catfishTarget === modelId) {
    systemPrompt += '\n\n' + CATFISH_PROMPT;
    session.catfishActive = false;
    session.catfishTarget = null;
  }
  const phasePrompt = getPhasePrompt(phase);
  const isChallenge = phase === 'challenge';
  const conversationMsgs = buildConversationMessages(session, modelId, isChallenge);

  const chatMessages = [
    { role: 'system', content: systemPrompt },
    ...conversationMsgs,
    { role: 'user', content: `${phasePrompt}\n\nYour turn, ${modelId}. Confidence 0-100 REQUIRED.` }
  ];

  const start = Date.now();
  try {
    // GAP 4: auto-retry 1x — pass historyMode to control truncation
    const chatOpts = { historyMode: session.history_mode || 'compact' };
    const result = await callWithRetry(provider, chatMessages, 1, chatOpts);
    provider.errorCount = 0;

    const response = {
      content: result.content,
      response_meta: result.response_meta || null,
      thinking: result.thinking || null,
      confidence: result.confidence || null,
      tokens: result.tokens,
      latency_ms: Date.now() - start,
      cost_usd: trackSessionCost(session.id, modelId, result.tokens)
    };

    // Per-response sycophancy + critique enforcement (Challenge phase only)
    if (isChallenge && result.content) {
      const lower = (typeof result.content === 'string' ? result.content : JSON.stringify(result.content)).toLowerCase();
      const agreeWords = ['i agree', 'correct', 'exactly', 'well said', 'good point', 'valid approach', 'setuju', 'benar', 'you are right'];
      const critiqueWords = ['however', 'but', 'disagree', 'flaw', 'weakness', 'incorrect', 'wrong', 'kelemahan', 'salah', 'tidak', 'counter', 'rebuttal'];
      const agreeCount = agreeWords.filter(w => lower.includes(w)).length;
      const critiqueCount = critiqueWords.filter(w => lower.includes(w)).length;

      const hasWeakness = lower.includes('weakness') || lower.includes('kelemahan') || lower.includes('flaw');
      const hasCounterargument = lower.includes('counter') || lower.includes('rebuttal') || lower.includes('disagree') || lower.includes('however') || lower.includes('but');
      const hasSteelMan = lower.includes('steel_man') || lower.includes('steel man') || lower.includes('strongest point') || lower.includes('poin terkuat');
      const critiqueRequired = hasWeakness && hasCounterargument;

      if (!critiqueRequired) {
        try {
          const antiSycResult = await callWithRetry(provider, [
            ...chatMessages,
            { role: 'assistant', content: result.content },
            { role: 'user', content: 'Your Challenge response LACKS required elements. You MUST include: (1) steel_man (acknowledge strongest point), (2) weakness (identify flaw in another approach), (3) counterargument/rebuttal (argue why their approach fails). Rewrite with these elements clearly labeled.' }
          ], 1, chatOpts);
          if (antiSycResult.content && !antiSycResult.refused) {
            response.content = antiSycResult.content;
            response.sycophancy_retry = true;
            response.tokens = antiSycResult.tokens;
            response.cost_usd = trackSessionCost(session.id, modelId, antiSycResult.tokens);
          }
        } catch { /* retry failed */ }
      }
      response.sycophancy_score = { agree: agreeCount, critique: critiqueCount, ratio: critiqueCount > 0 ? agreeCount / critiqueCount : agreeCount > 0 ? 999 : 0 };
      response.critique_check = { has_weakness: hasWeakness, has_counterargument: hasCounterargument, has_steel_man: hasSteelMan, critique_required_passed: critiqueRequired };
    }

    SessionManager.addResponse(session, phase, modelId, response);

    // Challenge Q&A: SIMPAN questions saja, jawaban di call TERPISAH (plan Bug 28: 1 model per call)
    if (isChallenge && result.content) {
      try {
        const jsonMatch = result.content.match(/\{[\s\S]*"questions"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed?.questions?.length) {
            session.pendingQuestions = parsed.questions.map(q => ({
              from: modelId,
              to: DEANON_MAP[q.to] || DEANON_MAP[q.to?.toLowerCase()] || q.to,
              question: q.question
            }));
            SessionManager.save(session);
            response.pending_qa = session.pendingQuestions.length;
          }
        }
      } catch {
        try {
          const retryResult = await callWithRetry(provider, [
            ...chatMessages,
            { role: 'assistant', content: result.content },
            { role: 'user', content: 'Your output was not valid JSON. Re-output as valid JSON: {"questions":[...],"critique":{...},"defense":"...","confidence":N}' }
          ]);
          const retryMatch = retryResult.content?.match(/\{[\s\S]*"questions"[\s\S]*\}/);
          if (retryMatch) {
            const retryParsed = JSON.parse(retryMatch[0]);
            if (retryParsed?.questions?.length) {
              session.pendingQuestions = retryParsed.questions.map(q => ({
                from: modelId,
                to: DEANON_MAP[q.to] || DEANON_MAP[q.to?.toLowerCase()] || q.to,
                question: q.question
              }));
              SessionManager.save(session);
              response.pending_qa = session.pendingQuestions.length;
              response.json_retry = 'success';
            }
          }
        } catch { response.json_retry = 'failed'; }
      }
    }

    // Parse tool_requests from model response (any phase)
    if (result.content) {
      const { requests: toolReqs, parse_error: toolParseErr } = parseToolRequests(result.content, modelId);
      if (toolReqs.length > 0) {
        if (!session.pendingCommands) session.pendingCommands = [];
        const sessionCmdCount = (session.phases['tool_observations'] || []).length;
        if (sessionCmdCount + session.pendingCommands.length + toolReqs.length <= MAX_PER_SESSION) {
          session.pendingCommands.push(...toolReqs);
          response.pending_commands = toolReqs.length;
        } else {
          response.command_limit = `Session command limit (${MAX_PER_SESSION}) reached`;
        }
      }
      if (toolParseErr) response.tool_parse_error = toolParseErr;
    }

    session.currentModelIndex++;
    SessionManager.save(session);

    const isPhaseComplete = session.currentModelIndex >= modelOrder.length;
    let collapseWarning = null;
    if (isPhaseComplete && (phase === 'challenge' || phase === 'closing')) {
      const collapse = detectCollapse(session);
      if (collapse.collapsed) {
        const phaseResponses = session.phases[phase] || [];
        const agreeModels = phaseResponses.filter(r => !r.error).map(r => r.model);
        session.catfishActive = true;
        session.catfishTarget = agreeModels[agreeModels.length - 1] || modelOrder[0];
        SessionManager.save(session);
        collapseWarning = {
          alert: 'COLLAPSE DETECTED — CATFISH auto-injected',
          unjustified_agrees: collapse.unjustifiedAgrees,
          catfish_target: session.catfishTarget,
          recommendation: 'CATFISH will auto-inject to next round. Or override: mcp_respond({type:"redirect", response:"BREAK CONSENSUS"})'
        };
      }
    }

    let driftWarning = null;
    if (isPhaseComplete) {
      const drift = detectRoleDrift(session);
      if (drift.hasDrift) {
        driftWarning = { alert: 'ROLE DRIFT DETECTED', models: drift.drifted.map(d => `${d.model}: drift ${d.drift} in ${d.phase}`) };
      }
    }

    return {
      session_id: session.id, phase, model: modelId, response,
      phase_complete: isPhaseComplete,
      next_model: isPhaseComplete ? null : modelOrder[session.currentModelIndex],
      status: isPhaseComplete ? 'host_window' : 'model_responded',
      collapse_warning: collapseWarning,
      drift_warning: driftWarning,
      message: isPhaseComplete
        ? `Phase ${phase} complete.${collapseWarning ? ' ⚠️ COLLAPSE!' : ''}${driftWarning ? ' ⚠️ DRIFT!' : ''} HOST_WINDOW open.`
        : `${provider.name} responded. Next: ${modelOrder[session.currentModelIndex]}.`
    };
  } catch (err) {
    provider.errorCount = (provider.errorCount || 0) + 1;
    if (provider.errorCount >= 3) {
      provider.disabled = true;
      provider.disabledAt = Date.now();
    }

    session.currentModelIndex++;
    const isTimeout = /timeout|ETIMEDOUT|aborted/i.test(err.message || '');
    const errorMsg = isTimeout ? `[${modelId} TIMEOUT — skipped]` : `[${modelId} ERROR: ${err.message}]`;

    SessionManager.addResponse(session, phase, modelId, {
      content: errorMsg, confidence: 0, tokens: { input: 0, output: 0, thinking: 0 }, error: true
    });
    SessionManager.save(session);

    return {
      session_id: session.id, phase, model: modelId, error: errorMsg,
      latency_ms: Date.now() - start,
      next_model: modelOrder[session.currentModelIndex] || null,
      status: 'model_error',
      circuit_breaker: provider.errorCount >= 3 ? `${modelId} DISABLED 5 min` : null
    };
  }

  } finally { session._processing = false; }
}

async function runSynthesis(session) {
  if (!session.phases['closing'] || session.phases['closing'].filter(r => !r.error).length === 0) {
    session.currentPhase = 'closing';
    session.currentModelIndex = 0;
    SessionManager.save(session);
    return {
      session_id: session.id, phase: 'closing', status: 'closing_required',
      message: 'CLOSING required before synthesis. mcp_respond({action:"continue"}).',
      next_model: session.modelOrder[0]
    };
  }

  session.currentPhase = 'synthesis';
  const synthIdx = ((session.roundNumber || 1) - 1) % session.modelOrder.length;
  let synthesizerId = session.modelOrder[synthIdx];
  let provider = getProvider(synthesizerId);
  if (!provider || provider.disabled) {
    synthesizerId = session.modelOrder.find(m => { const p = getProvider(m); return p && !p.disabled; });
    provider = synthesizerId ? getProvider(synthesizerId) : null;
  }
  if (!provider) return { error: 'No synthesizer available' };

  const systemPrompt = getSystemPrompt(session.style, synthesizerId);
  const phasePrompt = getPhasePrompt('synthesis');
  const history = buildConversationMessages(session, synthesizerId, false);

  const start = Date.now();
  try {
    const result = await callWithRetry(provider, [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: phasePrompt }
    ]);

    let synthContent = result.content;
    const evidenceTags = ['[VERIFIED]', '[LIKELY]', '[HYPOTHESIS]', '[INVALID]', '[UNRESOLVED]'];
    const hasEvidence = evidenceTags.some(tag => synthContent.includes(tag));

    if (!hasEvidence) {
      try {
        const retryResult = await callWithRetry(provider, [
          { role: 'system', content: systemPrompt },
          ...history,
          { role: 'assistant', content: synthContent },
          { role: 'user', content: 'Your synthesis is MISSING evidence status tags. REWRITE with [VERIFIED], [LIKELY], [HYPOTHESIS], [INVALID], or [UNRESOLVED] for each recommendation/claim. Do NOT use confidence scores as evidence.' }
        ]);
        if (retryResult.content && evidenceTags.some(t => retryResult.content.includes(t))) {
          synthContent = retryResult.content;
        }
      } catch { /* re-prompt failed, keep original */ }
    }

    const taggedContent = synthContent;
    const hasTagsNow = evidenceTags.some(t => taggedContent.includes(t));

    // Reference validation: [VERIFIED] claims should reference evidence
    const verifiedClaims = (taggedContent.match(/\[VERIFIED\][^\n]*/g) || []);
    const hasToolObs = (session.phases['tool_observations'] || []).length > 0;
    const referencePhrases = ['TOOL_OBSERVATION', 'runbook', 'source', 'output', 'evidence:', 'dari recon', 'from recon', 'confirmed'];
    const verifiedWithRef = verifiedClaims.filter(c => referencePhrases.some(r => c.toLowerCase().includes(r.toLowerCase())));
    const verifiedNoRef = verifiedClaims.length - verifiedWithRef.length;

    session.synthesis = {
      model: synthesizerId, content: taggedContent, tokens: result.tokens,
      latency_ms: Date.now() - start,
      cost_usd: trackSessionCost(session.id, synthesizerId, result.tokens),
      evidence_tagged: hasTagsNow,
      evidence_audit: {
        total_verified_claims: verifiedClaims.length,
        with_reference: verifiedWithRef.length,
        without_reference: verifiedNoRef,
        has_tool_observations: hasToolObs
      }
    };
    SessionManager.save(session);

    const gateStatus = !hasTagsNow ? 'FAILED — no evidence tags'
      : verifiedNoRef > 0 ? `WARNING — ${verifiedNoRef}/${verifiedClaims.length} [VERIFIED] claims lack evidence reference`
      : 'PASSED';

    return {
      session_id: session.id, phase: 'synthesis', synthesis: session.synthesis,
      evidence_gate: gateStatus,
      status: 'host_window',
      message: 'Synthesis complete. mcp_respond({action:"close"}) or {action:"retry"}.'
    };
  } catch (err) {
    return { error: `Synthesis failed: ${err.message}`, session_id: session.id };
  }
}
