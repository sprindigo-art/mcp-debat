import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNBOOKS_DIR = join(__dirname, '..', '..', 'runbooks');
const MEMORY_DIR = join(__dirname, '..', '..', 'memory');
const CONCLUSIONS_PATH = join(MEMORY_DIR, 'conclusions.json');

export function loadRunbook(target) {
  const exactPatterns = [
    `RUNBOOK_${target}.md`,
    `RUNBOOK_${target.replace(/\./g, '_')}.md`,
    `RUNBOOK_${target.replace(/\//g, '_')}.md`
  ];

  for (const filename of exactPatterns) {
    const path = join(RUNBOOKS_DIR, filename);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, 'utf-8');
        console.error(`[notebook] TARGET-LOCKED: loaded ${filename} for target "${target}"`);
        return content;
      } catch { /* continue */ }
    }
  }

  console.error(`[notebook] TARGET-LOCKED: no exact match for "${target}" — debate proceeds without runbook. Candidates NOT searched (target-lock enforced).`);
  return null;
}

export function summarizeRunbook(content, maxChars = 8000) {
  if (!content) return '';
  if (content.length <= maxChars) return content;

  const prioritySections = ['## INFO', '## RECON', '## GAGAL', '## LIVE STATUS', '## CREDENTIAL', '## EXPLOIT'];
  const parts = [];
  let remaining = maxChars;

  for (const section of prioritySections) {
    const regex = new RegExp(`${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?(?=\\n## |$)`, 'i');
    const match = content.match(regex);
    if (match && remaining > 0) {
      const text = match[0].substring(0, Math.min(match[0].length, remaining));
      parts.push(text);
      remaining -= text.length;
    }
  }

  return parts.join('\n\n---\n\n');
}

export function loadConclusions(topic, maxResults = 5) {
  if (!existsSync(CONCLUSIONS_PATH)) return [];

  try {
    const all = JSON.parse(readFileSync(CONCLUSIONS_PATH, 'utf-8'));
    if (!Array.isArray(all)) return [];

    const topicWords = topic.toLowerCase().split(/\s+/);
    const scored = all.map(c => {
      const text = `${c.topic || ''} ${(c.tags || []).join(' ')} ${(c.conclusions || []).join(' ')}`.toLowerCase();
      const score = topicWords.filter(w => text.includes(w)).length;
      return { ...c, _score: score };
    });

    return scored.filter(c => c._score > 0).sort((a, b) => b._score - a._score).slice(0, maxResults);
  } catch {
    return [];
  }
}

export function saveConclusions(sessionData) {
  let all = [];
  if (existsSync(CONCLUSIONS_PATH)) {
    try { all = JSON.parse(readFileSync(CONCLUSIONS_PATH, 'utf-8')); } catch { all = []; }
  }

  const entry = {
    id: sessionData.id,
    session_id: sessionData.id,
    topic: sessionData.topic,
    target: sessionData.target,
    conclusions: sessionData.conclusions || [],
    synthesis: sessionData.synthesis?.content?.substring(0, 2000) || '',
    confidence_avg: 0,
    style: sessionData.style,
    created_at: new Date().toISOString(),
    tags: extractTags(sessionData)
  };

  all.push(entry);
  if (all.length > 200) all = all.slice(-200);

  writeFileSync(CONCLUSIONS_PATH, JSON.stringify(all, null, 2));
  return entry;
}

function extractTags(session) {
  const text = `${session.topic} ${session.target || ''} ${session.context || ''}`;
  const tags = [];

  const cveMatch = text.match(/CVE-\d{4}-\d+/gi);
  if (cveMatch) tags.push(...cveMatch);

  const domainMatch = text.match(/[\w.-]+\.\w{2,}/g);
  if (domainMatch) tags.push(...domainMatch.slice(0, 3));

  const techMatch = text.match(/nginx|apache|php|node|python|mysql|postgresql|redis|tomcat|iis/gi);
  if (techMatch) tags.push(...[...new Set(techMatch.map(t => t.toLowerCase()))]);

  return [...new Set(tags)];
}
