const CATFISH_PROMPT = `CATFISH INJECTION — You have been activated because the debate is COLLAPSING into false consensus.

Your SOLE PURPOSE: BREAK the consensus. Find flaws that others are ignoring.
- DO NOT agree with the majority
- Find the WEAKEST assumption in the current consensus
- Propose a COMPLETELY DIFFERENT approach that nobody has considered
- Be aggressive in your critique — the other models are being too agreeable
- If everyone says "X works", your job is to explain why X will FAIL

This is TEMPORARY — you exist only to prevent echo chamber collapse.`;

export function detectCollapse(session) {
  const phase = session.currentPhase;
  const responses = session.phases[phase] || [];

  if (responses.length < 3) return { collapsed: false };

  let unjustifiedAgrees = 0;
  let lastContent = '';

  for (let i = 1; i < responses.length; i++) {
    const curr = responses[i];
    const prev = responses[i - 1];
    const currText = (typeof curr.content === 'string' ? curr.content : JSON.stringify(curr.content)).toLowerCase();
    const prevText = (typeof prev.content === 'string' ? prev.content : JSON.stringify(prev.content)).toLowerCase();

    const agreePatterns = ['i agree', 'correct', 'exactly', 'well said', 'good point', 'you are right', 'valid approach', 'setuju', 'benar'];
    const hasNewEvidence = currText.length > prevText.length * 0.5 && !agreePatterns.some(p => currText.startsWith(p));

    const isUnjustifiedAgree = agreePatterns.some(p => currText.includes(p)) && !hasNewEvidence;
    if (isUnjustifiedAgree) unjustifiedAgrees++;

    const similarity = calculateSimilarity(currText, prevText);
    if (similarity > 0.7) unjustifiedAgrees++;
  }

  const collapsed = unjustifiedAgrees >= 3;

  return {
    collapsed,
    unjustifiedAgrees,
    totalResponses: responses.length,
    catfishPrompt: collapsed ? CATFISH_PROMPT : null
  };
}

function calculateSimilarity(a, b) {
  if (!a || !b) return 0;
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 3));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

const ROLE_PROFILES = {
  deepseek: { challenge: 0.45, question: 0.25, support: 0.15 },
  gemini:   { challenge: 0.20, question: 0.20, support: 0.30 },
  mistral:  { challenge: 0.20, question: 0.25, support: 0.25 },
  anthropic:{ challenge: 0.50, question: 0.15, support: 0.10 },
  qwen:     { challenge: 0.30, question: 0.15, support: 0.20 },
  openai:   { challenge: 0.30, question: 0.15, support: 0.20 }
};

const CHALLENGE_WORDS = ['disagree', 'wrong', 'flaw', 'weakness', 'but', 'however', 'incorrect', 'salah', 'kelemahan', 'tidak'];
const QUESTION_WORDS = ['?', 'how', 'why', 'what if', 'have you', 'bagaimana', 'kenapa', 'apakah'];
const SUPPORT_WORDS = ['agree', 'correct', 'exactly', 'good point', 'valid', 'setuju', 'benar', 'support'];

function classifySpeechActs(text) {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/).length || 1;
  let challenge = 0, question = 0, support = 0;
  for (const w of CHALLENGE_WORDS) { const m = lower.split(w).length - 1; challenge += m; }
  for (const w of QUESTION_WORDS) { const m = lower.split(w).length - 1; question += m; }
  for (const w of SUPPORT_WORDS) { const m = lower.split(w).length - 1; support += m; }
  const total = challenge + question + support || 1;
  return { challenge: challenge / total, question: question / total, support: support / total };
}

export function detectRoleDrift(session) {
  const drifted = [];
  for (const phase of ['constructive', 'challenge', 'closing']) {
    const responses = session.phases[phase] || [];
    for (const r of responses) {
      if (r.error || !r.content) continue;
      const text = typeof r.content === 'string' ? r.content : JSON.stringify(r.content);
      const acts = classifySpeechActs(text);
      const expected = ROLE_PROFILES[r.model];
      if (!expected) continue;
      const drift = Math.abs(acts.challenge - expected.challenge) +
                    Math.abs(acts.question - expected.question) +
                    Math.abs(acts.support - expected.support);
      if (drift > 0.4) {
        drifted.push({ model: r.model, phase, drift: Math.round(drift * 100) / 100, actual: acts, expected });
      }
    }
  }
  return { drifted, hasDrift: drifted.length > 0 };
}

export { CATFISH_PROMPT };
