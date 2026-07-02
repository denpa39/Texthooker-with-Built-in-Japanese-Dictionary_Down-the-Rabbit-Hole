/* Down the Rabbit Hole — front-end --------------------------------------- *
 * - tokenizes incoming Japanese with kuromoji
 * - renders words as hoverable spans (with optional furigana)
 * - fetches offline JMdict definitions from the local server on hover
 * ------------------------------------------------------------------------ */

const linesEl = document.getElementById("lines");
const popup = document.getElementById("popup");
const statusEl = document.getElementById("status");
const hint = document.getElementById("hint");

// Connection status is a plain coloured dot; the label lives only in title/aria-label.
function setStatus(state, label) {
  statusEl.className = "status " + state;
  statusEl.title = label;
  statusEl.setAttribute("aria-label", label);
}

let tokenizer = null;
let showFurigana = false;
let lookupCache = new Map();

/* ---- known-word tracking (persisted) ----------------------------------- */
const KNOWN_KEY = "vntex-known";
let knownWords;
try { knownWords = new Set(JSON.parse(localStorage.getItem(KNOWN_KEY)) || []); }
catch (_) { knownWords = new Set(); }
function saveKnown() {
  try { localStorage.setItem(KNOWN_KEY, JSON.stringify([...knownWords])); } catch (_) {}
}
function refreshKnown(term) {
  document.querySelectorAll(".token.word").forEach(sp => {
    if (!term || sp.dataset.term === term)
      sp.classList.toggle("known", knownWords.has(sp.dataset.term));
  });
}

/* ---- session persistence + reading stats ------------------------------- */
const SESSION_KEY = "vntex-session";
let sessionChars = 0;    // characters read since this page loaded (drives 字/時)
let sessionStart = 0;    // first line's timestamp this page-load
let restoring = false;   // true while replaying saved lines (no save/stat churn)

function savedLines() {
  return [...linesEl.children].map(l => l.dataset.raw).filter(Boolean);
}
function saveSession() {
  if (restoring) return;
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(savedLines())); } catch (_) {}
}
const statsEl = document.getElementById("stats");
function bumpStats(text) {
  if (restoring) return;
  const chars = text.replace(/\s/g, "").length;
  if (!sessionStart) sessionStart = Date.now();
  sessionChars += chars;
  const hours = (Date.now() - sessionStart) / 3600000;
  const rate = hours > 0.005 ? Math.round(sessionChars / hours) : 0;
  statsEl.textContent = sessionChars.toLocaleString() + "字" +
                        (rate ? " · " + rate.toLocaleString() + "字/時" : "");
}

/* ---- POS abbreviation expansion (common JMdict tags) ------------------- */
const POS = {
  "n": "noun", "pn": "pronoun", "adj-i": "い-adjective", "adj-na": "な-adjective",
  "adj-no": "の-adjective", "adv": "adverb", "adv-to": "adverb (と)", "aux": "auxiliary",
  "aux-v": "auxiliary verb", "aux-adj": "auxiliary adjective", "conj": "conjunction",
  "cop": "copula", "ctr": "counter", "exp": "expression", "int": "interjection",
  "prt": "particle", "pref": "prefix", "suf": "suffix", "num": "numeric",
  "v1": "ichidan verb", "v5": "godan verb", "v5r": "godan verb (-る)",
  "v5u": "godan verb (-う)", "v5k": "godan verb (-く)", "v5g": "godan verb (-ぐ)",
  "v5s": "godan verb (-す)", "v5t": "godan verb (-つ)", "v5n": "godan verb (-ぬ)",
  "v5b": "godan verb (-ぶ)", "v5m": "godan verb (-む)", "vs": "する verb",
  "vs-i": "する verb (irregular)", "vs-s": "する verb (special)", "vk": "くる verb",
  "vi": "intransitive verb", "vt": "transitive verb", "vz": "ずる verb",
};
const expandPos = p => POS[p] || p;

const MISC = {
  "uk": "usu. kana", "col": "colloquial", "sl": "slang", "vulg": "vulgar",
  "fam": "familiar", "hon": "honorific", "hum": "humble", "pol": "polite",
  "arch": "archaic", "obs": "obsolete", "rare": "rare", "dated": "dated", "hist": "historical",
  "fem": "female term", "male": "male term", "form": "formal", "euph": "euphemistic",
  "abbr": "abbreviation", "on-mim": "onomatopoeia", "joc": "jocular", "derog": "derogatory",
  "poet": "poetic", "chn": "children's term", "yoji": "four-character idiom", "proverb": "proverb",
};
const expandMisc = m => MISC[m] || m;

/* ---- inflection-trail labels (raw de-inflection tags -> readable) ------- */
const REASON = {
  "-た": "past", "-て": "-te form", "-ば": "conditional", "-たら": "conditional (tara)",
  "-たり": "-tari", "-く": "adverbial", "-さ": "-sa nominal", "-ず": "without doing",
  "-ぬ": "negative (archaic)", "-ん": "negative (casual)", "-ゃ": "contraction",
  "-ちゃ": "contraction (-cha)", "continuative": "masu stem", "-まい": "won't/probably not",
  "potential or passive": "potential or passive",
};
const expandReason = r => REASON[r] || r;
const isDatedSense = s => (s.misc || []).some(m => m === "arch" || m === "obs" || m === "rare");

/* ---- katakana -> hiragana (for furigana) ------------------------------ */
function toHiragana(s) {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0);
    out += (c >= 0x30a1 && c <= 0x30f6) ? String.fromCodePoint(c - 0x60) : ch;
  }
  return out;
}
const hasKanji = s => /[一-龯々]/.test(s);
const isJapanese = s => /[぀-ヿ一-龯々ｦ-ﾟ]/.test(s);

/* ---- tokenizer init ---------------------------------------------------- */
kuromoji.builder({ dicPath: "/static/kuromoji/dict" }).build((err, tk) => {
  if (err) {
    console.error(err);
    return;
  }
  tokenizer = tk;
  // Re-render any lines that arrived before the tokenizer was ready.
  rebuildSentences();
});

// Rebuild the tokenized text of every line in place.
function rebuildSentences() {
  document.querySelectorAll(".line[data-raw]").forEach(line => {
    const sentence = line.querySelector(".sentence");
    const rebuilt = buildSentence(line.dataset.raw);
    if (sentence) sentence.replaceWith(rebuilt);
    else line.insertBefore(rebuilt, line.firstChild);
  });
}

/* ---- rendering --------------------------------------------------------- */
function buildSentence(text) {
  const div = document.createElement("div");
  div.className = "sentence";

  if (!tokenizer) {
    div.textContent = text;            // plain until tokenizer is ready
    return div;
  }

  const tokens = tokenizer.tokenize(text);
  for (const t of tokens) {
    const surface = t.surface_form;
    const span = document.createElement("span");
    span.className = "token";

    if (isJapanese(surface) && t.pos !== "記号") {
      span.classList.add("word");
      span.tabIndex = 0;                 // reachable by keyboard
      span.setAttribute("role", "button");
      // dictionary form: prefer basic_form (handles inflection), else surface
      const base = (t.basic_form && t.basic_form !== "*") ? t.basic_form : surface;
      span.dataset.term = base;
      span.dataset.surface = surface;
      span.dataset.pos = t.pos || "";
      span.dataset.jreading = (t.reading && t.reading !== "*") ? t.reading : "";
      span.dataset.off = String((t.word_position || 1) - 1);  // start index in the line
      if (knownWords.has(base)) span.classList.add("known");

      if (showFurigana && hasKanji(surface) && t.reading && t.reading !== "*") {
        const ruby = document.createElement("ruby");
        ruby.textContent = surface;
        const rt = document.createElement("rt");
        rt.textContent = toHiragana(t.reading);
        ruby.appendChild(rt);
        span.appendChild(ruby);
      } else {
        span.textContent = surface;
      }
    } else {
      span.textContent = surface;
    }
    div.appendChild(span);
  }
  return div;
}

function addLine(text) {
  text = (text || "").replace(/\r/g, "").trim();
  if (!text) return;
  // The SSE stream replays the last line on every (re)connect; with the session
  // restored from storage that replay would duplicate it. Consecutive identical
  // lines can't come from the clipboard (the server dedupes), so skip them.
  const last = linesEl.lastElementChild;
  if (last && last.dataset.raw === text) return;
  hint.classList.add("gone");

  document.querySelectorAll(".line.latest").forEach(e => e.classList.remove("latest"));

  const line = document.createElement("div");
  line.className = "line latest";
  line.dataset.raw = text;
  line.appendChild(buildSentence(text));

  // Only auto-scroll if the reader was already at the bottom — don't yank the user
  // away when they've scrolled up to re-read. (Measured before append.)
  const wasAtBottom = linesEl.scrollHeight - linesEl.scrollTop - linesEl.clientHeight < 80;
  linesEl.appendChild(line);
  if (wasAtBottom) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    linesEl.scrollTo({ top: linesEl.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  }

  // keep DOM bounded
  while (linesEl.children.length > 300) linesEl.removeChild(linesEl.firstChild);

  bumpStats(text);
  saveSession();
}

// Restore the previous session's lines (tokenizer-independent: rebuildSentences
// re-renders them once kuromoji is ready).
(function restoreSession() {
  let lines;
  try { lines = JSON.parse(localStorage.getItem(SESSION_KEY)) || []; } catch (_) { lines = []; }
  if (!lines.length) return;
  restoring = true;
  lines.forEach(addLine);
  restoring = false;
})();

/* ---- dictionary lookup + popup (longest-match scan) -------------------- */
let pinned = false;

async function fetchScan(text, pos, reading, base, surface) {
  const key = [pos || "", reading || "", base || "", surface || "", text].join("|");
  if (lookupCache.has(key)) return lookupCache.get(key);
  try {
    const r = await fetch("/scan?text=" + encodeURIComponent(text) +
                          "&pos=" + encodeURIComponent(pos || "") +
                          "&reading=" + encodeURIComponent(reading || "") +
                          "&base=" + encodeURIComponent(base || "") +
                          "&surface=" + encodeURIComponent(surface || ""));
    const res = (await r.json()).candidates || [];
    lookupCache.set(key, res);
    return res;
  } catch (e) {
    return [];
  }
}

function plainReading(reading) {
  const rd = document.createElement("span");
  rd.className = "reading";
  rd.textContent = reading;
  return rd;
}

function renderSense(s, n) {
  const sense = document.createElement("div");
  sense.className = "sense";
  if (s.pos && s.pos.length) {
    const pos = document.createElement("span");
    pos.className = "pos";
    pos.textContent = s.pos.map(expandPos).join(", ");
    sense.appendChild(pos);
  }
  const g = document.createElement("span");
  g.className = "glosses";
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = n + ".";
  g.appendChild(num);
  let txt = s.gloss.join("; ");
  if (s.misc && s.misc.length) txt = "(" + s.misc.map(expandMisc).join(", ") + ") " + txt;
  g.appendChild(document.createTextNode(txt));
  sense.appendChild(g);
  return sense;
}

/* ---- Anki export (via the server's /anki proxy to AnkiConnect) ---------- */
const ANKI_DECK = "Down the Rabbit Hole";
const ANKI_MODEL = "Down the Rabbit Hole";
let ankiReady = false;

async function anki(action, params) {
  const r = await fetch("/anki", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, version: 6, params: params || {} }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Create our deck + note type once, so export works with zero Anki-side setup.
async function ensureAnki() {
  if (ankiReady) return;
  const models = await anki("modelNames");
  if (!models.includes(ANKI_MODEL)) {
    await anki("createModel", {
      modelName: ANKI_MODEL,
      inOrderFields: ["Word", "Reading", "Meaning", "Sentence"],
      cardTemplates: [{
        Name: "Card 1",
        Front: '<div style="font-size:40px">{{Word}}</div><div>{{Sentence}}</div>',
        Back: '<div style="font-size:40px">{{Word}}</div>{{Reading}}<hr>{{Meaning}}<hr>{{Sentence}}',
      }],
    });
  }
  await anki("createDeck", { deck: ANKI_DECK });   // no-op if it exists
  ankiReady = true;
}

async function addToAnki(c, sentence, btn) {
  const entry = c.entry;
  const word = (entry.k && entry.k[0]) || (entry.r && entry.r[0]) || c.matched;
  const reading = (c.mr || (entry.r && entry.r[0]) || "") +
                  (c.pitch != null ? ` [${c.pitch}]` : "");
  const meaning = (entry.s || []).slice(0, 3)
    .map((s, i) => (i + 1) + ". " + s.gloss.join("; ")).join("<br>");
  try {
    await ensureAnki();
    await anki("addNote", {
      note: {
        deckName: ANKI_DECK, modelName: ANKI_MODEL,
        fields: { Word: word, Reading: reading, Meaning: meaning, Sentence: sentence || "" },
        options: { allowDuplicate: false },
      },
    });
    btn.textContent = "✓";
    btn.title = "added to Anki";
  } catch (e) {
    btn.textContent = "✗";
    btn.title = "Anki: " + e.message;   // hover the button to see why
  }
  setTimeout(() => { btn.textContent = "★"; btn.title = "add to Anki"; }, 1800);
}

function renderCandidate(c, sentence) {
  const entry = c.entry;
  const div = document.createElement("div");
  div.className = "entry" + (c.kind === "name" ? " name" : "");

  // inflection trail: 食べさせられた · causative › passive › past
  if (c.reasons && c.reasons.length) {
    const inf = document.createElement("div");
    inf.className = "inflect";
    inf.textContent = c.matched + "  ·  " + c.reasons.map(expandReason).join(" › ");
    div.appendChild(inf);
  }

  const head = document.createElement("div");
  head.className = "head";
  // Headword + reading. When *every* sense is "usually kana", show the kana as the
  // headword (やはり, not 矢張り). Otherwise show the kanji, with the reading that
  // actually matched the hover (口【こう】 when hovered こう, not the primary 口【くち】).
  const senses = entry.s || [];
  const hasKanji = !!(entry.k && entry.k.length);
  const allUk = c.kind !== "name" && hasKanji && senses.length &&
                senses.every(s => (s.misc || []).includes("uk"));
  const primary = allUk ? entry.r[0]
                        : ((entry.k && entry.k[0]) || (entry.r && entry.r[0]) || c.matched);
  const hw = document.createElement("span");
  hw.className = "hw";
  hw.textContent = primary;
  head.appendChild(hw);
  const readingShown = c.mr || (entry.r && entry.r[0]);
  if (!allUk && hasKanji && readingShown) {
    head.appendChild(plainReading(readingShown));
  }
  // pitch-accent chip (Kanjium): 0 = heiban, n = downstep after mora n
  if (c.pitch != null) {
    const p = document.createElement("span");
    p.className = "pitch";
    p.textContent = "⬇" + String(c.pitch).split(",").join("·");
    p.title = "pitch accent (0 = flat, n = drop after mora n)";
    head.appendChild(p);
  }
  // VN-frequency chip: how common this word is in visual novels
  if (typeof entry.vr === "number") {
    const f = document.createElement("span");
    f.className = "freq" + (entry.vr <= 6600 ? " hot" : "");
    f.textContent = "№" + entry.vr.toLocaleString();
    f.title = "visual-novel frequency rank" + (entry.vr <= 6600 ? " (common — worth learning)" : "");
    head.appendChild(f);
  }
  if (c.kind === "name") {
    const tag = document.createElement("span");
    tag.className = "name-tag";   // pushed right via margin-left:auto
    tag.textContent = "name";
    head.appendChild(tag);
  }

  const copy = document.createElement("button");
  // for words there's no badge, so the copy button carries the right-align push
  copy.className = "mini" + (c.kind === "name" ? "" : " push");
  copy.textContent = "⧉";
  copy.title = "copy word";
  copy.setAttribute("aria-label", "copy word");
  copy.addEventListener("click", ev => {
    ev.stopPropagation();
    if (!navigator.clipboard) return;
    // only show ✓ once the write actually succeeds
    navigator.clipboard.writeText(primary).then(() => {
      copy.textContent = "✓";
      setTimeout(() => (copy.textContent = "⧉"), 900);
    }).catch(() => {});
  });
  head.appendChild(copy);

  const jisho = document.createElement("a");
  jisho.className = "mini";
  jisho.textContent = "↗";
  jisho.title = "look up on Jisho.org";
  jisho.setAttribute("aria-label", "look up " + primary + " on Jisho.org");
  jisho.href = "https://jisho.org/search/" + encodeURIComponent(primary);
  jisho.target = "_blank";
  jisho.rel = "noopener";
  jisho.addEventListener("click", ev => ev.stopPropagation());
  head.appendChild(jisho);

  if (c.kind !== "name") {
    const star = document.createElement("button");
    star.className = "mini";
    star.textContent = "★";
    star.title = "add to Anki";
    star.setAttribute("aria-label", "add " + primary + " to Anki");
    star.addEventListener("click", ev => {
      ev.stopPropagation();
      addToAnki(c, sentence, star);
    });
    head.appendChild(star);
  }
  div.appendChild(head);

  // "also written": for a kana-headword (all-uk) entry surface the kanji form(s).
  const alts = allUk
    ? [...(entry.k || []), ...(entry.r || []).slice(1)]
    : [...(entry.k || []).slice(1), ...(hasKanji ? [] : (entry.r || []).slice(1))];
  if (alts.length) {
    const alt = document.createElement("div");
    alt.className = "alt";
    alt.textContent = "also: " + alts.join("、");
    div.appendChild(alt);
  }

  // Senses. Fold archaic/obsolete/rare senses behind a toggle — but only when a
  // modern sense remains (a wholly-archaic entry still renders all of its senses).
  const modern = senses.filter(s => !isDatedSense(s));
  const dated = senses.filter(isDatedSense);
  const fold = modern.length > 0 && dated.length > 0;
  const visible = fold ? modern : senses;
  visible.forEach((s, i) => div.appendChild(renderSense(s, i + 1)));
  if (fold) {
    const more = document.createElement("div");
    more.className = "fold";
    more.textContent = `+ ${dated.length} rare / archaic sense${dated.length > 1 ? "s" : ""}`;
    more.addEventListener("click", ev => {
      ev.stopPropagation();
      dated.forEach((s, i) => div.insertBefore(renderSense(s, visible.length + i + 1), more));
      more.remove();
    });
    div.appendChild(more);
  }
  return div;
}

let lookupSeq = 0;
async function showScanPopup(target) {
  const line = target.closest(".line");
  if (!line) return;
  const off = parseInt(target.dataset.off || "0", 10);
  const text = line.dataset.raw.slice(off);
  const seq = ++lookupSeq;
  const cands = await fetchScan(text, target.dataset.pos, target.dataset.jreading,
                                target.dataset.term, target.dataset.surface);
  // A newer peek superseded this one while the lookup was in flight — drop it so a
  // slow response can't overwrite the word the user is now on. (Pins always render.)
  if (!pinned && seq !== lookupSeq) return;

  popup.innerHTML = "";
  if (pinned) {
    const close = document.createElement("button");
    close.className = "pin-close";
    close.textContent = "×";
    close.title = "close";
    close.setAttribute("aria-label", "close");
    close.addEventListener("click", unpin);
    popup.appendChild(close);
  }
  if (!cands.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = `No entry for 「${target.dataset.surface || target.dataset.term}」`;
    popup.appendChild(e);
  } else {
    cands.forEach(c => popup.appendChild(renderCandidate(c, line.dataset.raw)));
  }
  // Pinned popup: mark the hovered word known/unknown (known words dim in the reader).
  if (pinned) {
    const term = target.dataset.term;
    const kb = document.createElement("button");
    kb.className = "known-btn" + (knownWords.has(term) ? " on" : "");
    kb.textContent = knownWords.has(term) ? "✓ known — click to unmark" : "mark 「" + term + "」 as known";
    kb.addEventListener("click", ev => {
      ev.stopPropagation();
      if (knownWords.has(term)) knownWords.delete(term);
      else knownWords.add(term);
      saveKnown();
      refreshKnown(term);
      kb.classList.toggle("on", knownWords.has(term));
      kb.textContent = knownWords.has(term) ? "✓ known — click to unmark" : "mark 「" + term + "」 as known";
    });
    popup.appendChild(kb);
  }
  // Peek footer: teach the two least-discoverable features (and signal scrollability).
  let foot = null;
  if (!pinned && cands.length) {
    foot = document.createElement("div");
    foot.className = "popup-foot";
    popup.appendChild(foot);
  }
  popup.scrollTop = 0;   // new word -> start at the top, don't inherit the last scroll
  positionPopup(target);
  if (foot) {
    const more = popup.scrollHeight > popup.clientHeight + 1;
    foot.textContent = more ? "click to pin · scroll for more ↓" : "click to pin";
  }
  popup.classList.remove("hidden");
}

function positionPopup(target) {
  popup.classList.remove("hidden");
  popup.style.maxHeight = "";                 // reset before measuring natural height
  const r = target.getBoundingClientRect();
  const gap = 8, margin = 10;
  const vw = window.innerWidth, vh = window.innerHeight;

  const pw = Math.min(popup.offsetWidth || 440, vw - 2 * margin);
  const left = Math.min(Math.max(margin, r.left), vw - pw - margin);

  // Place the popup fully below or fully above the word — never overlapping it —
  // and cap its height to the room on that side (it scrolls if taller). This stops
  // a tall popup from blanketing the screen and covering the word you're reading.
  const below = vh - r.bottom - gap - margin;
  const above = r.top - gap - margin;
  const ph = popup.offsetHeight;
  let top, maxH;
  if (ph <= below || below >= above) {        // below the word
    top = r.bottom + gap;
    maxH = below;
  } else {                                    // above the word (bottom edge above r.top)
    maxH = above;
    top = r.top - gap - Math.min(ph, maxH);
  }
  popup.style.maxHeight = Math.max(120, maxH) + "px";
  popup.style.left = left + "px";
  popup.style.top = Math.max(margin, top) + "px";
}

let hideTimer = null;
function scheduleHide() {
  if (pinned) return;
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => { popup.classList.add("hidden"); activeWord = null; }, 180);
}
function cancelHide() { clearTimeout(hideTimer); }
function unpin() {
  pinned = false;
  activeWord = null;
  popup.classList.remove("pinned");
  popup.classList.add("hidden");
}

let activeWord = null;   // the word the popup is currently showing (flicker guard)
function peek(t) {
  if (!t || pinned || t === activeWord) return;   // skip re-render of the same word
  activeWord = t;
  cancelHide();
  showScanPopup(t);
}
function pin(t) {
  pinned = true;
  popup.classList.add("pinned");
  activeWord = t;
  cancelHide();
  showScanPopup(t);
}
linesEl.addEventListener("mouseover", e => peek(e.target.closest(".token.word")));
linesEl.addEventListener("mouseout", e => { if (e.target.closest(".token.word")) scheduleHide(); });
linesEl.addEventListener("click", e => { const t = e.target.closest(".token.word"); if (t) pin(t); });
// keyboard: Tab to a word (focus peeks it), Enter/Space pins it open.
linesEl.addEventListener("focusin", e => peek(e.target.closest(".token.word")));
linesEl.addEventListener("focusout", e => { if (e.target.closest(".token.word")) scheduleHide(); });
linesEl.addEventListener("keydown", e => {
  const t = e.target.closest(".token.word");
  if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); pin(t); }
});
popup.addEventListener("mouseenter", cancelHide);
popup.addEventListener("mouseleave", scheduleHide);

// The hover popup is pointer-events:none so it never blocks hovering the words
// beneath it — which also means the wheel can't scroll it natively. So while a
// peek popup is open, route the wheel to it manually AND keep the page still: the
// wheel only scrolls the meaning, so the word never slides out from under the
// cursor mid-read. Move off the word to scroll the page again. (A pinned popup is
// interactive and scrolls natively, so leave it alone.)
window.addEventListener("wheel", (e) => {
  if (pinned || popup.classList.contains("hidden")) return;
  popup.scrollTop += e.deltaY;
  e.preventDefault();
}, { passive: false });
document.addEventListener("keydown", e => { if (e.key === "Escape") unpin(); });
document.addEventListener("click", e => {
  if (pinned && !e.target.closest(".token.word") && !e.target.closest("#popup")) unpin();
});

/* ---- clipboard stream (SSE) ------------------------------------------- */
function connectStream() {
  const es = new EventSource("/events");
  es.onopen = () => {
    // don't flash "ready" over a paused session
    if (!pauseBtn.classList.contains("active")) setStatus("ready", "Ready");
  };
  es.onmessage = ev => {
    try { addLine(JSON.parse(ev.data).text); } catch (_) {}
  };
  es.onerror = () => {
    if (!pauseBtn.classList.contains("active")) setStatus("connecting", "Disconnected — reconnecting…");
    // EventSource auto-reconnects.
  };
}
connectStream();

/* ---- toolbar ----------------------------------------------------------- */
const pauseBtn = document.getElementById("pauseBtn");
async function refreshPause() {
  const j = await (await fetch("/state")).json();
  applyPause(j.paused);
}
function applyPause(paused) {
  pauseBtn.classList.toggle("active", paused);
  pauseBtn.textContent = paused ? "Resume" : "Pause";
  setStatus(paused ? "paused" : "ready", paused ? "Paused" : "Ready");
}
pauseBtn.addEventListener("click", async () => {
  const want = !pauseBtn.classList.contains("active");
  const j = await (await fetch("/pause", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused: want }),
  })).json();
  applyPause(j.paused);
});
refreshPause();

const furiBtn = document.getElementById("furiBtn");
furiBtn.addEventListener("click", () => {
  showFurigana = !showFurigana;
  furiBtn.classList.toggle("active", showFurigana);
  rebuildSentences();
});

// Remove only the most recent line (undo), and move the "latest" highlight back.
document.getElementById("clearBtn").addEventListener("click", () => {
  const last = linesEl.lastElementChild;
  if (!last) return;
  if (!popup.classList.contains("hidden")) unpin();  // close any popup tied to it
  last.remove();
  const prev = linesEl.lastElementChild;
  if (prev) {
    prev.classList.add("latest");
  } else {
    hint.classList.remove("gone");  // back to empty state
  }
  saveSession();
});

// Clear all lines — asks once (inline) before wiping everything.
const clearAllBtn = document.getElementById("clearAllBtn");
let clearArmed = false, clearTimer = null;
function disarmClear() {
  clearArmed = false; clearTimeout(clearTimer);
  clearAllBtn.classList.remove("confirm");
  clearAllBtn.textContent = "Clear";
  clearAllBtn.title = "Clear all lines";
}
clearAllBtn.addEventListener("click", () => {
  if (!clearArmed) {                       // first click: arm + ask
    clearArmed = true;
    clearAllBtn.classList.add("confirm");
    clearAllBtn.textContent = "Clear?";
    clearAllBtn.title = "Click again to clear everything";
    clearTimer = setTimeout(disarmClear, 2500);
    return;
  }
  disarmClear();                           // second click: do it
  if (!popup.classList.contains("hidden")) unpin();
  linesEl.innerHTML = "";
  hint.classList.remove("gone");
  saveSession();
});

// Export the session as a plain-text file, one line per hooked line.
document.getElementById("exportBtn").addEventListener("click", () => {
  const lines = savedLines();
  if (!lines.length) return;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "rabbit-hole-" + stamp + ".txt";
  a.click();
  URL.revokeObjectURL(a.href);
});

// Appearance (theme / colours / font / text size) lives in settings.js, which
// also wires up the toolbar's #fontRange size slider.
