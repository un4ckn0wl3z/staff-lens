# StaffLens — Build Spec (Phase 1 / MVP)

> Hand this file to Claude Code: "Read STAFFLENS_SPEC.md and build Phase 1."

## Context

StaffLens is a new tool for the **Unknown Guitar Toolkits** collection
(https://github.com/un4ckn0wl3z/unknown-guitar-toolkits). Sibling tools:
TabLens (tab image → .gp5), Riff Forge, Tempo Bench, Solo Smith, Guitar Stem Studio.

Collection conventions to follow:
- Runs entirely in the browser on the user's machine. No backend, no uploads, no telemetry.
- Static site deployable to GitHub Pages (`base` path must be configurable).
- UI in **Thai and English** (toggle), **light and dark** theme.
- Tools hand off to each other through Guitar Pro files (`.gp5`).

StaffLens is the counterpart of TabLens: it takes **standard notation (staff)**, explains it
in detail for learners, plays it, and converts it to guitar tab.

## Tech stack

- Vite + TypeScript, no heavy UI framework required (vanilla TS or Preact is fine).
- **alphaTab** (`@coderline/alphatab`) as the core: renders staff + tab together, playback via
  SoundFont, note click events, Guitar Pro / MusicXML import.
  - Configure alphaTab's font, SoundFont and worker asset paths so they work under a GitHub Pages sub-path.
  - Verify against the installed alphaTab version which exporters exist (it may export `.gp`/GP7
    rather than `.gp5`) — see "Export" below.

## Phase 1 scope

### 1. Input
- Open file via button or drag-and-drop: **MusicXML (.musicxml/.xml), compressed MXL (.mxl),
  Guitar Pro (.gp/.gpx/.gp5/.gp4/.gp3)**.
- Ship a bundled demo: **Aura Lee** (public domain, 1861) as MusicXML in `public/samples/`
  (see fixture below), loadable with one click.
- Image/PDF input is Phase 2 — show a disabled "Image / PDF (coming soon)" entry.

### 2. Rendering
- Show staff and tab together (alphaTab `StaveProfile` score + tab).
- Toggle: staff only / tab only / both.
- Playback cursor follows on both staves; auto-scroll.

### 3. Score overview panel (whole-piece explanation)
Plain-language explanation, beginner friendly, TH/EN:
- Clef and what it means.
- Key signature → candidate keys (e.g. "1 sharp = G major or E minor"), then pick the likely one
  from the notes (first/last note, most frequent tones, final chord if present).
- Time signature and what one beat is.
- Tempo, section labels (Verse/Chorus), repeats/voltas/D.S./Coda.
- **Play order map**: list of bar numbers in actual playback order when repeats exist.

### 4. Click a note → note explanation panel
For the selected note show:
- Name with octave in scientific pitch notation. For guitar show both **written** and
  **sounding** pitch (guitar sounds one octave lower than written) and explain that briefly.
- Duration name + how many beats; which beat of the bar it starts on.
- Where the accidental comes from: key signature, explicit accidental, or carried within the bar.
  Example: "This F is played as F# because of the key signature."
- Interval from the previous note (e.g. "up a perfect 4th").
- Scale degree in the detected key.
- If a chord symbol is active at that beat: chord tone (root/3rd/5th/7th) or non-chord tone.
- **All playable fretboard positions** for that pitch (standard tuning, frets 0–15),
  marking the one currently used in the tab, with suggested finger.
- Mini fretboard diagram highlighting the positions.
- Beginner / detailed mode toggle.
- Clicking a note also **plays it** immediately.

### 5. Click a chord symbol → chord panel
- Play the chord (strum and arpeggio buttons).
- Chord formula and notes (e.g. `E7 = 1-3-5-♭7 = E G# B D`), explain the symbol suffix
  (7, maj7, m7, m, dim, sus, add9 at minimum).
- Function in the detected key where obvious (e.g. G7 → C = V7 → I; E7 → Am = V7 of vi).
- One or two common open/barre chord diagrams.
- If alphaTab does not expose chord symbols from MusicXML `<harmony>`, parse them from the
  MusicXML directly and map to beat positions.

### 6. Staff → tab conversion (the key feature)
Implement a **fingering optimizer** instead of relying on default fret assignment:
- For each note, candidates = every (string, fret) producing that pitch in the current tuning
  within `[capo, maxFret]`.
- Choose the sequence with minimum total cost (Viterbi / dynamic programming over notes;
  chords = choose a set of distinct strings per beat).
- Cost terms (weights tunable in code):
  - hand position shift between consecutive notes,
  - stretch beyond a 4-fret span from the current hand position,
  - string skipping,
  - bonus for open strings in "open position" mode,
  - penalty for high frets in beginner mode.
- Modes: **Open position (default)**, **Stay in position N**, **Minimize movement**.
- User can **lock** a note to a specific string/fret by clicking a tab number and choosing from a
  popover; re-optimize the rest around locked notes.
- Settings: tuning presets (Standard, Drop D, DADGAD, Half-step down), capo 0–9.
- **Range check**: notes not playable on guitar (e.g. piano or violin parts) are flagged; offer
  "shift octave up/down" for the whole part or a selection.
- Optional: **"Add bass from chords"** — put the chord root on a low string on beat 1 of each bar
  under the melody (simple fingerstyle arrangement), only where it does not clash with the
  melody's string.
- Re-render tab live after any change.

### 7. Playback
- Play / pause / stop, play from clicked note, loop a selected bar range.
- Tempo slider (50%–150%) without pitch change, metronome toggle, count-in.
- Mute/solo melody vs chord accompaniment (accompaniment generated from chord symbols as a
  simple strum track when chord symbols exist).
- Guitar SoundFont (nylon/steel selectable if the SoundFont supports it).

### 8. Interactive fretboard
- Full fretboard strip under the score; highlights the current/selected note.
- Two-way: clicking a fret plays the pitch and highlights matching notes in the score.

### 9. Export
- **Guitar Pro**: the collection uses `.gp5`. If alphaTab only exports GP7 (`.gp`), either
  (a) check whether Riff Forge / Tempo Bench accept `.gp`, or
  (b) reuse the GP5 writer from TabLens (https://github.com/un4ckn0wl3z/TabLens).
  Decide after checking and document the choice in the README.
- MIDI (alphaTab MIDI generation).
- ASCII tab (plain text, 4 bars per line, aligned columns).
- PNG/PDF print of staff + tab (browser print stylesheet is acceptable for PDF).

## Non-functional

- Works offline after first load (PWA/service worker optional but preferred).
- Responsive down to phone width; touch-friendly hit targets on notes.
- Accessible: keyboard navigation between notes (←/→), Space to play/pause.
- All theory logic (pitch math, key detection, intervals, optimizer) in a pure TypeScript module
  `src/theory/` with **unit tests (Vitest)**, independent of alphaTab.

## Test fixture: Aura Lee (key G, 4/4)

Melody as written (quarter notes unless noted; h = half, w = whole):

| Bars | Notes |
|---|---|
| 1–4 (Verse) | D4 G4 F#4 G4 · A4 E4 A4(h) · G4 F#4 E4 F#4 · G4(w) |
| 5–8 | repeat of 1–4 |
| 9–12 (Chorus) | B4 B4 B4(h) · B4 B4 B4(h) · B4 A4 G4 A4 · B4(w) |
| 13–16 | B4 B4 C5 B4 · A4 E4 A4 G4 · G4 F#4 B4 A4 · G4(w) |

Expected open-position tab (string:fret, string 1 = high E):
- D4 → 4:0, E4 → 4:2, F#4 → 4:4, G4 → 3:0, A4 → 3:2, B4 → 2:0, C5 → 2:1

Unit tests should assert the optimizer produces exactly these positions in "Open position" mode.

Second fixture idea: a short melody containing E7, Am, D7, G7, C chord symbols, to test the
chord panel and chord-tone labelling.

## Deliverables

- New repo layout ready to become `un4ckn0wl3z/staff-lens`:
  `src/`, `src/theory/`, `public/samples/`, `tests/`, `README.md` (TH/EN), GitHub Pages workflow.
- README section to add StaffLens to the collection's landing table, with its place in the flow:
  `staff image/PDF/MusicXML → StaffLens → .gp5 → Riff Forge → Tempo Bench`.

## Later phases (do not build now, but keep the architecture ready)

- **Phase 2 — OMR**: image/PDF (pdf.js) input, deskew/perspective correction, in-browser optical
  music recognition (candidate: oemer models via onnxruntime-web), chord-symbol OCR
  (Tesseract.js), low-confidence highlighting, and a note editor to correct recognition.
  Keep an internal score model that both OMR output and file import convert into.
- **Phase 3 — Practice**: note-naming and fretboard quizzes, timed reading drills,
  microphone play-along with monophonic pitch detection.
