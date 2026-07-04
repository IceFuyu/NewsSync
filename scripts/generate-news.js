// Läuft serverseitig (z.B. per GitHub Actions Cron) mit einem echten Anthropic-API-Key.
// Erzeugt/aktualisiert news.json, archive.json und weekly-review.json im Repo-Root.
// Die Website (index.html) macht selbst KEINE API-Aufrufe mehr, sondern liest nur diese Dateien.
//
// Unterstützt mehrere Themen (aktuell KI + Finanzen) über die TOPICS-Konfiguration.
// Jedes Feed-Item bekommt ein `topic`-Feld, damit die Website einen gemeinsamen,
// nach Thema filterbaren Feed anzeigen kann.

import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error('ANTHROPIC_API_KEY fehlt (als GitHub-Secret setzen).');
  process.exit(1);
}

const ROOT = process.cwd();
const NEWS_PATH = path.join(ROOT, 'news.json');
const ARCHIVE_PATH = path.join(ROOT, 'archive.json');
const WEEKLY_PATH = path.join(ROOT, 'weekly-review.json');

function extractJSON(text) {
  let t = (text || '').trim();
  t = t.replace(/^[\s\S]*?(?=[\[{])/, '');
  t = t.replace(/`{3}[a-z]*\n?/gi, '').replace(/`{3}/g, '');
  const last = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (last === -1) throw new Error('Kein JSON in der Antwort gefunden: ' + t.slice(0, 200));
  t = t.slice(0, last + 1);
  return JSON.parse(t);
}

async function callClaude(prompt, useWebSearch, maxTokens) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 4096,
    messages: [{ role: 'user', content: prompt }]
  };
  if (useWebSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API-Fehler ${res.status}: ${errText.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJSON(text);
}

async function readJSON(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    return fallback;
  }
}

function todayKey(d) {
  d = d || new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `day-${y}-${m}-${day}`;
}

/* ============================================================
   TOPICS
   ============================================================ */
const TOPICS = [
  {
    id: 'ki',
    label: 'KI',
    count: 6,
    categories: '"Modelle", "Tools", "Unternehmen", "Wirtschaft", "Forschung", "Politik"',
    beat: 'die KI-Welt (Sprachmodelle, KI-Tools, KI-Unternehmen & Wirtschaft, KI-Forschung, KI-Politik/Regulierung)'
  },
  {
    id: 'finanzen',
    label: 'Finanzen',
    count: 6,
    categories: '"Märkte", "Unternehmen", "Zentralbanken", "Krypto", "Rohstoffe"',
    beat: 'die Finanzwelt (Aktienmärkte, Unternehmenszahlen, Zentralbanken & Zinsen, Kryptowährungen, Rohstoffe)'
  }
];

function feedPrompt(topic) {
  return `Du bist Redakteur für "NewSync", ein privates News-Dashboard, Ressort ${topic.label}. Recherchiere per Websuche die ${topic.count} wichtigsten AKTUELLEN Nachrichten der letzten 1-3 Tage aus ${topic.beat}.

Gib AUSSCHLIESSLICH reines JSON zurück, ohne Markdown, ohne Codeblock-Zäune, ohne Erklärtext. Format: ein JSON-Array mit genau ${topic.count} Objekten, jedes mit den Feldern:
- headline: string, Deutsch, maximal 12 Wörter
- why: string, 1-2 Sätze: was ist passiert und warum ist es relevant
- category: string, GENAU EINER dieser Werte: ${topic.categories}
- source: string, Name der Quelle
- url: string, Link zum Original-Artikel
- image: string oder null, eine Bild-URL falls bekannt, sonst null
- models: array von strings, erwähnte Modellnamen/Produkte/Assets (kann leer sein)
- companies: array von strings, erwähnte Firmennamen (kann leer sein)

Antworte NUR mit dem JSON-Array.`;
}

function detailPrompt(topic, post) {
  return `Du bist Redakteur für "NewSync", Ressort ${topic.label}. Erstelle eine vertiefte Einordnung zu folgender Nachricht. Nutze Websuche für zusätzlichen Kontext.

Headline: ${post.headline}
Kurzfassung: ${post.why}
Quelle: ${post.source} (${post.url})

Gib AUSSCHLIESSLICH reines JSON zurück, ohne Markdown, ohne Codeblock-Zäune. Format: ein JSON-Objekt mit:
- what: string, 3-4 Sätze, was genau ist passiert
- why: string, 2-3 Sätze, warum ist das wichtig
- impact: array von 3-4 strings, konkrete Auswirkungen
- context: string, Einordnung im Vergleich zu früheren Entwicklungen
- takeaway: string, 1 prägnanter Satz als Fazit

Antworte NUR mit dem JSON-Objekt.`;
}

function weeklyPrompt(topic, items) {
  return `Du bist Redakteur für "NewSync", Ressort ${topic.label}. Hier ist eine Liste von Nachrichten der letzten 7 Tage als JSON:
${JSON.stringify(items.map(i => ({ headline: i.headline, why: i.why, category: i.category })))}

Erstelle daraus OHNE Websuche, NUR basierend auf diesen Daten, einen Wochenrückblick. Gib AUSSCHLIESSLICH reines JSON zurück, ohne Markdown, ohne Codeblock-Zäune. Format: ein JSON-Objekt mit:
- summary: string, die Woche in 3-4 Sätzen
- highlights: array von 3-5 strings, die wichtigsten Punkte
- trend: string, ein übergreifender Trend dieser Woche
- watch: string, worauf man als Nächstes achten sollte

Antworte NUR mit dem JSON-Objekt.`;
}

async function main() {
  const archive = await readJSON(ARCHIVE_PATH, {});

  // Bereits bekannte Detail-Einordnungen wiederverwenden statt neu zu generieren (spart Kosten)
  const knownDetails = new Map();
  for (const day of Object.values(archive)) {
    for (const it of day) if (it.detail) knownDetails.set(it.headline, it.detail);
  }

  let allNewItems = [];
  for (const topic of TOPICS) {
    console.log(`Lade aktuelle News (${topic.label}) per Websuche...`);
    const items = await callClaude(feedPrompt(topic), true);
    if (!Array.isArray(items)) throw new Error(`Unerwartetes Feed-Format für Thema ${topic.id}`);
    for (const item of items) {
      item.topic = topic.id;
      if (knownDetails.has(item.headline)) {
        item.detail = knownDetails.get(item.headline);
        continue;
      }
      try {
        console.log('Erzeuge Einordnung für:', item.headline);
        item.detail = await callClaude(detailPrompt(topic, item), true, 2048);
      } catch (e) {
        console.error('Detail-Fehler für "' + item.headline + '":', e.message);
        item.detail = null;
      }
    }
    allNewItems = allNewItems.concat(items);
  }

  const key = todayKey();
  const existingToday = archive[key] || [];
  const seen = new Set(existingToday.map(x => x.headline));
  const mergedToday = existingToday.slice();
  for (const it of allNewItems) {
    if (!seen.has(it.headline)) { mergedToday.push(it); seen.add(it.headline); }
  }
  archive[key] = mergedToday;

  // Archiv auf die letzten 30 Tage begrenzen, damit die Datei nicht unbegrenzt wächst
  const keys = Object.keys(archive).sort();
  const keptKeys = keys.slice(-30);
  const prunedArchive = {};
  for (const k of keptKeys) prunedArchive[k] = archive[k];

  await fs.writeFile(NEWS_PATH, JSON.stringify(allNewItems, null, 2));
  await fs.writeFile(ARCHIVE_PATH, JSON.stringify(prunedArchive, null, 2));
  console.log(`Feed aktualisiert: ${allNewItems.length} Meldungen (${TOPICS.map(t => t.label).join(', ')}). Archiv-Tage: ${keptKeys.length}.`);

  // Wochenrückblick pro Thema (ohne Websuche, nur aus Archivdaten)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekly = {};
  for (const topic of TOPICS) {
    let weekItems = [];
    for (const k of keptKeys) {
      const parts = k.replace('day-', '').split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
      if (d >= cutoff) weekItems = weekItems.concat((prunedArchive[k] || []).filter(it => it.topic === topic.id));
    }
    if (weekItems.length >= 3) {
      try {
        const review = await callClaude(weeklyPrompt(topic, weekItems), false, 1024);
        review.generatedAt = new Date().toISOString();
        weekly[topic.id] = review;
        console.log(`Wochenrückblick (${topic.label}) aktualisiert.`);
      } catch (e) {
        console.error(`Wochenrückblick-Fehler (${topic.label}):`, e.message);
      }
    } else {
      console.log(`Noch zu wenig Material für Wochenrückblick ${topic.label} (${weekItems.length} Meldungen).`);
    }
  }
  await fs.writeFile(WEEKLY_PATH, JSON.stringify(weekly, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
