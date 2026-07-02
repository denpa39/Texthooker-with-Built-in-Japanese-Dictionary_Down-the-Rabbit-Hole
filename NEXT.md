# Next improvements — handoff

Backlog for "Down the Rabbit Hole" (VN texthooker + offline JMdict dictionary).
Repo: Python stdlib server (`server.py`), setup/DB builder (`setup.py`), de-inflector
(`deinflect.py` + generated `deinflect_data.py`), front-end (`static/app.js`,
`settings.js`, `style.css`, `index.html`). DB = `dict.sqlite` (gitignored, built by
`python setup.py`). Tests: `test_ranking.py`, `python deinflect.py`. Verify UI with the
preview tools on `.claude/launch.json` server "texthooker" (port 6972).

Ranked by value. Each notes rough scope + where it touches.

## Dictionary / lookup
1. **Kanji info (KANJIDIC2)** — new table in `setup.py` (readings, meanings, strokes,
   JLPT, radical). Click a kanji in the popup header → mini kanji card. Big learner win,
   medium effort. New `/kanji` route in `server.py`, render in `app.js`.
2. **Example sentences (Tatoeba/Tanaka)** — one more table in `setup.py`, collapsed
   section in the popup. Medium.
3. **Pitch-accent graph** — draw the LH contour over the kana instead of the ⬇n number.
   Data already stored (`c.pitch`); pure SVG/CSS in `app.js`/`style.css`. Small, high polish.
4. **Word audio** — 🔊 button, Yomitan-style JapanesePod101 URL. Needs internet; optional.
5. **Hide-names toggle** — popup filter button; name clusters can be noisy. Small.

## Study loop
6. **Anki polish** — configurable deck name (settings), duplicate-detected feedback text,
   optional audio field, one-time "Anki: connected ✓/not found" indicator in the toolbar.
   Core export already verified working. Small.
7. **Known-words v2** — import/export the list, "assume top-N frequency known" bulk-dim,
   per-line coverage % ("you know 87% of this line"), option to show furigana only on
   unknown words. Builds on existing `knownWords` Set in `app.js`. Medium.
8. **Manual lookup box** — type/paste a word to search without hooking it. Trivial: reuse
   the `/scan` route + `fetchScan`.

## Infra / UX
9. **WebSocket text input** — accept Textractor/LunaTranslator/Agent websocket directly
   (convention: ws on 6677/9001) instead of only clipboard. No clipboard race, works when
   another app owns the clipboard, cross-platform. New thread in `server.py`. Medium-large.
10. **Server-side session log** — append each line to a per-day `.txt` on disk (named per
    game). Survives browser-storage wipe and the 300-line DOM cap. Small, in `server.py`.
11. **LAN mode** — `--host 0.0.0.0` + phone/tablet-friendly layout so you can read on a
    second device while the game runs on PC. Small server flag + responsive CSS pass.
12. **Packaging** — PyInstaller one-exe for non-Python users. `setup.bat` is half-way.

## Cheapest high-value first: 8, 3, 5.  Biggest wins: 1, 9, 7.

## Known loose ends (from the last session)
- Yomitan rule table is **GPL-3.0** (`deinflect_data.py`) — if the repo is published,
  it must carry a GPL-compatible licence. Noted in README "Data & licences".
- One test Anki card (食べる) may still be in the user's Anki deck "Down the Rabbit Hole".
- `dict.sqlite` not committed by design; fresh clones run `python setup.py`.
