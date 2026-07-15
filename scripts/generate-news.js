// Läuft serverseitig (GitHub Actions, manuell ausgelöst) mit einem echten Anthropic-API-Key.
// Erzeugt/aktualisiert news.json, archive.json und weekly-review.json im Repo-Root.
// Die Website (index.html) macht selbst KEINE API-Aufrufe, sondern liest nur diese Dateien.
//
// Ablauf:
//   1. RSS-Feeds werden direkt vom Runner geholt (kostenlos, keine Websuche)
//   2. Bereits archivierte Artikel werden im Code aussortiert (kostet keine Tokens)
//   3. EIN Modell-Aufruf pro Thema wählt aus, ordnet ein und schreibt die Detailtexte
//
// Kosten: grob 5-8 Cent pro Lauf. Die früher genutzte Websuche kostete das ~50-fache.

import fs from 'node:fs/promises';
import path from 'node:path';

// --dry-run: holt nur die RSS-Feeds und zeigt, was ankommt.
// Kein Modell-Aufruf, keine Kosten, kein API-Key nötig, schreibt keine Dateien.
// Zum Testen der Quellen:  node scripts/generate-news.js --dry-run
const DRY_RUN = process.argv.includes('--dry-run');

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY && !DRY_RUN) {
  console.error('ANTHROPIC_API_KEY fehlt (als GitHub-Secret setzen).');
  process.exit(1);
}

const ROOT = process.cwd();
const NEWS_PATH = path.join(ROOT, 'news.json');
const ARCHIVE_PATH = path.join(ROOT, 'archive.json');
const WEEKLY_PATH = path.join(ROOT, 'weekly-review.json');

const MODEL = 'claude-haiku-4-5';
const PER_FEED = 12;        // max. Artikel pro Feed
const PER_SOURCE = 6;       // max. Kandidaten pro Quelle — verhindert, dass ein
                            // Vielschreiber die anderen Quellen verdrängt
const CANDIDATES = 30;      // max. Artikel, die dem Modell vorgelegt werden
const SUMMARY_CHARS = 300;  // Kürzung der RSS-Beschreibung (begrenzt Input-Tokens)
const MAX_AGE_DAYS = 7;     // Schutz vor eingeschlafenen Feeds: ältere Artikel
                            // werden verworfen (Artikel ohne Datum bleiben drin)

/* ============================================================
   TOPICS + FEEDS
   Neue Quelle hinzufügen: einfach einen Eintrag in `feeds` ergänzen.
   Fällt ein Feed aus, wird er übersprungen — der Lauf bricht nicht ab.
   ============================================================ */
const TOPICS = [
  {
    id: 'ki',
    label: 'KI',
    count: 6,
    categories: '"Modelle", "Tools", "Unternehmen", "Wirtschaft", "Forschung", "Politik"',
    beat: 'die KI-Welt (Sprachmodelle, KI-Tools, KI-Unternehmen & Wirtschaft, KI-Forschung, KI-Politik/Regulierung)',
    feeds: [
      { name: 'The Decoder', url: 'https://the-decoder.de/feed/' },
      { name: 't3n', url: 'https://t3n.de/tag/kuenstliche-intelligenz/rss.xml' },
      { name: 'The Verge', url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml' },
      { name: 'TechCrunch', url: 'https://techcrunch.com/category/artificial-intelligence/feed/' },
      { name: 'Ars Technica', url: 'https://arstechnica.com/ai/feed/' },
      { name: 'MIT Technology Review', url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/' }
    ]
  },
  {
    id: 'finanzen',
    label: 'Finanzen',
    count: 6,
    categories: '"Märkte", "Unternehmen", "Zentralbanken", "Krypto", "Rohstoffe"',
    beat: 'die Finanzwelt (Aktienmärkte, Unternehmenszahlen, Zentralbanken & Zinsen, Kryptowährungen, Rohstoffe)',
    feeds: [
      { name: 'tagesschau', url: 'https://www.tagesschau.de/wirtschaft/index~rss2.xml' },
      { name: 'Handelsblatt', url: 'https://www.handelsblatt.com/contentexport/feed/finanzen' },
      { name: 'n-tv', url: 'https://www.n-tv.de/wirtschaft/rss' },
      { name: 'CNBC', url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664' },
      // mw_topstories ist überwiegend Ratgeber-Kolumnen; mw_marketpulse und
      // mw_realtimeheadlines sind seit 2025 nicht mehr aktualisiert.
      { name: 'MarketWatch', url: 'https://feeds.content.dowjones.io/public/rss/mw_bulletins' },
      { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' }
    ]
  }
];

/* ============================================================
   RSS/ATOM-PARSER (ohne Dependencies)
   ============================================================ */
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function stripTags(s) {
  return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Liest <name>...</name>. Der (?:\s[^>]*)? verhindert, dass z.B. "content"
// fälschlich auf <content:encoded> matcht.
function tagText(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i'));
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return decodeEntities(stripTags(v)).trim();
}

function itemLink(xml) {
  // RSS 2.0: <link>https://...</link> — teils in CDATA verpackt (z.B. Handelsblatt)
  const rss = xml.match(/<link(?:\s[^>]*)?>([\s\S]*?)<\/link\s*>/i);
  if (rss) {
    let v = rss[1].trim();
    const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
    if (cdata) v = cdata[1].trim();
    if (v && !v.includes('<')) return decodeEntities(v);
  }
  // Atom: <link rel="alternate" href="https://..."/>
  const atom = xml.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/i);
  if (atom) return decodeEntities(atom[1]);
  // Fallback: <guid isPermaLink="true">https://...</guid>
  const guid = tagText(xml, 'guid');
  if (/^https?:\/\//i.test(guid)) return guid;
  return '';
}

function itemImage(xml) {
  const m = xml.match(/<(?:media:content|media:thumbnail|enclosure)[^>]*url=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : null;
}

function parseFeed(xml) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/gi) || [];
  return blocks.map(b => ({
    title: tagText(b, 'title'),
    summary: (tagText(b, 'description') || tagText(b, 'summary') || '').slice(0, SUMMARY_CHARS),
    url: itemLink(b),
    image: itemImage(b),
    date: tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated') || ''
  })).filter(i => i.title && i.url);
}

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'user-agent': 'NewSyncBot/1.0 (privates News-Dashboard)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const items = parseFeed(await res.text()).slice(0, PER_FEED);
    console.log(`  ${feed.name}: ${items.length} Artikel`);
    return items.map(i => ({ ...i, source: feed.name }));
  } catch (e) {
    console.error(`  ${feed.name}: FEHLER (${e.message}) — wird übersprungen`);
    return [];
  }
}

function parseDate(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

/* ============================================================
   ANTHROPIC API
   ============================================================ */
function extractJSON(text) {
  let t = (text || '').trim();
  t = t.replace(/`{3}[a-z]*\n?/gi, '').replace(/`{3}/g, '');
  t = t.replace(/^[\s\S]*?(?=[\[{])/, '');
  const last = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
  if (last === -1) throw new Error('Kein JSON in der Antwort gefunden: ' + t.slice(0, 200));
  return JSON.parse(t.slice(0, last + 1));
}

async function callClaude(prompt, maxTokens) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens || 4096,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API-Fehler ${res.status}: ${errText.slice(0, 400)}`);
  }
  const data = await res.json();
  if (data.stop_reason === 'max_tokens') {
    console.error('  WARNUNG: Antwort wurde bei max_tokens abgeschnitten.');
  }
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return extractJSON(text);
}

/* ============================================================
   PROMPTS
   ============================================================ */
function feedPrompt(topic, candidates) {
  const list = candidates.map((c, i) =>
    `${i}. [${c.source}] ${c.title}${c.summary ? '\n   ' + c.summary : ''}`
  ).join('\n');

  return `Du bist Redakteur für "NewSync", ein privates News-Dashboard, Ressort ${topic.label}.

Unten stehen aktuelle Schlagzeilen aus den RSS-Feeds mehrerer Nachrichtenquellen zu ${topic.beat}. Wähle daraus die ${topic.count} WICHTIGSTEN und interessantesten Meldungen aus und bereite sie auf. Ignoriere Meldungen, die nicht zum Ressort passen, sowie Werbung, Newsletter-Hinweise und Dopplungen (dieselbe Geschichte aus zwei Quellen: nimm nur eine).

SCHLAGZEILEN:
${list}

Gib AUSSCHLIESSLICH reines JSON zurück, ohne Markdown, ohne Codeblock-Zäune, ohne Erklärtext. Format: ein JSON-Array mit genau ${topic.count} Objekten, jedes mit den Feldern:
- id: number, die Nummer der Meldung aus der Liste oben (WICHTIG: exakt übernehmen, nicht erfinden)
- headline: string, Deutsch, maximal 12 Wörter, eigene prägnante Formulierung
- why: string, 1-2 Sätze auf Deutsch: was ist passiert und warum ist es relevant
- category: string, GENAU EINER dieser Werte: ${topic.categories}
- models: array von strings, erwähnte Modellnamen/Produkte/Assets (kann leer sein)
- companies: array von strings, erwähnte Firmennamen (kann leer sein)
- detail: objekt mit:
  - what: string, 3-4 Sätze, was genau ist passiert
  - why: string, 2-3 Sätze, warum ist das wichtig
  - impact: array von 3-4 strings, konkrete Auswirkungen
  - context: string, Einordnung im Vergleich zu früheren Entwicklungen
  - takeaway: string, 1 prägnanter Satz als Fazit

Alle Texte auf Deutsch, auch wenn die Quelle englisch ist. Stütze dich nur auf die Angaben oben und allgemein bekannten Kontext — erfinde keine Zahlen, Zitate oder Fakten. Wenn die Schlagzeile für eine Einordnung zu dünn ist, halte dich im detail-Objekt entsprechend kurz und allgemein.

Antworte NUR mit dem JSON-Array.`;
}

function weeklyPrompt(topic, items) {
  return `Du bist Redakteur für "NewSync", Ressort ${topic.label}. Hier ist eine Liste von Nachrichten der letzten 7 Tage als JSON:
${JSON.stringify(items.map(i => ({ headline: i.headline, why: i.why, category: i.category })))}

Erstelle daraus NUR basierend auf diesen Daten einen Wochenrückblick. Gib AUSSCHLIESSLICH reines JSON zurück, ohne Markdown, ohne Codeblock-Zäune. Format: ein JSON-Objekt mit:
- summary: string, die Woche in 3-4 Sätzen
- highlights: array von 3-5 strings, die wichtigsten Punkte
- trend: string, ein übergreifender Trend dieser Woche
- watch: string, worauf man als Nächstes achten sollte

Antworte NUR mit dem JSON-Objekt.`;
}

/* ============================================================
   MAIN
   ============================================================ */
function todayKey(d) {
  d = d || new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `day-${y}-${m}-${day}`;
}

async function readJSON(p, fallback) {
  try {
    return JSON.parse(await fs.readFile(p, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function main() {
  const archive = await readJSON(ARCHIVE_PATH, {});

  // Bereits abgedeckte Artikel-URLs sammeln, um Wiederholungen zu vermeiden.
  // Passiert im Code — kostet keine Tokens.
  const seenUrls = new Set();
  for (const day of Object.values(archive)) {
    for (const it of day) if (it.url) seenUrls.add(it.url);
  }

  let allNewItems = [];

  for (const topic of TOPICS) {
    console.log(`\n=== Ressort ${topic.label} ===`);
    console.log('Lade RSS-Feeds...');

    const fetched = (await Promise.all(topic.feeds.map(fetchFeed))).flat();

    // Dubletten (gleiche URL), bereits archivierte und veraltete Artikel entfernen
    const ageCutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const byUrl = new Map();
    let stale = 0;
    for (const it of fetched) {
      if (seenUrls.has(it.url) || byUrl.has(it.url)) continue;
      const t = parseDate(it.date);
      if (t && t < ageCutoff) { stale++; continue; }
      byUrl.set(it.url, it);
    }
    if (stale) console.log(`  (${stale} Artikel älter als ${MAX_AGE_DAYS} Tage verworfen)`);

    // Pro Quelle höchstens PER_SOURCE Artikel, damit ein Vielschreiber die
    // Liste nicht dominiert. Danach alles zusammen nach Aktualität sortieren.
    const perSource = new Map();
    for (const it of [...byUrl.values()].sort((a, b) => parseDate(b.date) - parseDate(a.date))) {
      const list = perSource.get(it.source) || [];
      if (list.length >= PER_SOURCE) continue;
      list.push(it);
      perSource.set(it.source, list);
    }

    const candidates = [...perSource.values()].flat()
      .sort((a, b) => parseDate(b.date) - parseDate(a.date))
      .slice(0, CANDIDATES);

    console.log(`${candidates.length} neue Artikel als Kandidaten (${fetched.length} geladen, Rest Dubletten/veraltet/bereits im Archiv).`);

    if (DRY_RUN) {
      for (const [i, c] of candidates.entries()) {
        console.log(`  ${String(i).padStart(2)}. [${c.source}] ${c.title}`);
        console.log(`      ${c.url}`);
        if (!c.summary) console.log('      (!) keine Beschreibung im Feed');
      }
      continue;
    }

    if (candidates.length < topic.count) {
      console.log(`Zu wenige neue Artikel für ${topic.label} — Ressort wird übersprungen.`);
      continue;
    }

    console.log('Wähle aus und ordne ein...');
    let picked;
    try {
      picked = await callClaude(feedPrompt(topic, candidates), 8192);
    } catch (e) {
      console.error(`Feed-Fehler (${topic.label}): ${e.message}`);
      continue;
    }
    if (!Array.isArray(picked)) {
      console.error(`Unerwartetes Feed-Format für Thema ${topic.id} — Ressort wird übersprungen.`);
      continue;
    }

    // Quelle, URL und Bild aus den echten RSS-Daten übernehmen — nicht vom Modell.
    // Damit können weder Links noch Quellen halluziniert werden.
    const items = [];
    for (const p of picked) {
      const src = candidates[p.id];
      if (!src) {
        console.error(`  Ungültige id ${p.id} übersprungen: "${p.headline}"`);
        continue;
      }
      items.push({
        headline: p.headline,
        why: p.why,
        category: p.category,
        source: src.source,
        url: src.url,
        image: src.image || null,
        models: Array.isArray(p.models) ? p.models : [],
        companies: Array.isArray(p.companies) ? p.companies : [],
        detail: p.detail || null,
        topic: topic.id
      });
      seenUrls.add(src.url);
    }

    console.log(`${items.length} Meldungen aufbereitet.`);
    allNewItems = allNewItems.concat(items);
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: keine Modell-Aufrufe, keine Kosten, keine Dateien geschrieben.');
    return;
  }

  if (allNewItems.length === 0) {
    console.error('Keine neuen Meldungen erzeugt — bestehende Dateien bleiben unverändert.');
    process.exit(1);
  }

  // Archiv aktualisieren
  const key = todayKey();
  const existingToday = archive[key] || [];
  const seenHeadlines = new Set(existingToday.map(x => x.headline));
  const mergedToday = existingToday.slice();
  for (const it of allNewItems) {
    if (!seenHeadlines.has(it.headline)) { mergedToday.push(it); seenHeadlines.add(it.headline); }
  }
  archive[key] = mergedToday;

  // Archiv auf die letzten 30 Tage begrenzen, damit die Datei nicht unbegrenzt wächst
  const keptKeys = Object.keys(archive).sort().slice(-30);
  const prunedArchive = {};
  for (const k of keptKeys) prunedArchive[k] = archive[k];

  await fs.writeFile(NEWS_PATH, JSON.stringify(allNewItems, null, 2));
  await fs.writeFile(ARCHIVE_PATH, JSON.stringify(prunedArchive, null, 2));
  console.log(`\nFeed aktualisiert: ${allNewItems.length} Meldungen (${TOPICS.map(t => t.label).join(', ')}). Archiv-Tage: ${keptKeys.length}.`);

  // Wochenrückblick pro Thema (nur aus Archivdaten)
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekly = await readJSON(WEEKLY_PATH, {});
  for (const topic of TOPICS) {
    let weekItems = [];
    for (const k of keptKeys) {
      const parts = k.replace('day-', '').split('-').map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
      if (d >= cutoff) weekItems = weekItems.concat((prunedArchive[k] || []).filter(it => it.topic === topic.id));
    }
    if (weekItems.length >= 3) {
      try {
        const review = await callClaude(weeklyPrompt(topic, weekItems), 1024);
        review.generatedAt = new Date().toISOString();
        weekly[topic.id] = review;
        console.log(`Wochenrückblick (${topic.label}) aktualisiert.`);
      } catch (e) {
        console.error(`Wochenrückblick-Fehler (${topic.label}): ${e.message}`);
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
