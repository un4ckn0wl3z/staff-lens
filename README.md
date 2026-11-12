# StaffLens

**Read, hear and play standard notation on guitar.**
**อ่าน ฟัง และเล่นโน้ตสากลบนกีตาร์**

StaffLens is part of the [Unknown Guitar Toolkits](https://github.com/un4ckn0wl3z/unknown-guitar-toolkits) collection. It is the counterpart of [TabLens](https://github.com/un4ckn0wl3z/TabLens): TabLens turns tab images into Guitar Pro files, StaffLens takes **standard notation**, explains it in plain language, plays it, and converts it to **guitar tab**.

Everything runs in your browser. No backend, no uploads, no telemetry. After the first visit it also works offline.

[ภาษาไทยด้านล่าง ↓](#ภาษาไทย)

```
staff image/PDF/MusicXML → StaffLens → .gp5 → Riff Forge → Tempo Bench
```

---

## Features (Phase 1)

- **Open** MusicXML (`.musicxml`, `.xml`), compressed MXL (`.mxl`) and Guitar Pro (`.gp`, `.gpx`, `.gp5`, `.gp4`, `.gp3`) with the button or by drag and drop. Two bundled demos: *Aura Lee* (public domain, 1861) and a short chord study. Image/PDF input is shown as "coming soon" (Phase 2).
- **Staff and tab together**, with a toggle for staff only, tab only or both. The playback cursor follows on both staves and the view scrolls with it.
- **Score overview**: clef, key signature with candidate keys ("1 sharp = G major or E minor") and the likely key with reasons, time signature and what one beat is, tempo, sections, repeats, voltas, D.C./D.S./Coda/Fine, a **play-order map** of bars in real playback order, the chords used (with Roman numerals), and the range.
- **Click a note** to hear it and get:
  - its written and sounding pitch (guitar sounds an octave lower than written), with a short explanation;
  - duration name, number of beats, and which beat it starts on;
  - where the sharp or flat comes from: key signature, a printed accidental, or one carried within the bar ("This F is played as F♯ because of the key signature");
  - the interval from the previous note, its scale degree in the detected key, and its role against the active chord (chord tone, or passing/neighbour/… non-chord tone);
  - **every playable fretboard position** (frets 0–15), the one used in the tab, the suggested finger, and a mini fretboard;
  - where it sits on the staff (line or space, ledger lines);
  - a Beginner / Detailed toggle. Detailed adds MIDI number and frequency, length in seconds, interval symbol and inversion, the full scale, the accidental rule and the chord's notes.
- **Click a chord symbol** (in the score or the overview) for strum and arpeggio playback, its formula and notes (`E7 = 1-3-5-♭7 = E G♯ B D`), what the suffix means, its function in the key (V7 → I, secondary dominants such as V7/vi), and open or barre chord diagrams.
- **Staff → tab conversion** with a fingering optimizer (see below): Open position (default), Stay in position N, Minimize movement; tuning presets (Standard, Drop D, DADGAD, Half-step down); capo 0–9; a beginner high-fret penalty; **lock** any note by clicking its tab number and choosing a string from the popover, and the rest is re-optimized around it; a **range check** marks notes the guitar cannot play in red, with octave shift for the whole part or the looped bars (non-guitar parts are shifted automatically when that helps); optional **"Add bass from chords"** for a simple fingerstyle arrangement.
- **Playback**: play/pause/stop, play from the selected note (clicking the score also moves the cursor), bar-range loop (type the bars or drag across the score), tempo 50–150 % without pitch change, metronome, count-in, a generated chord accompaniment (strum track) with a melody/chords mix, nylon or steel guitar sound.
- **Interactive fretboard** under the score: shows the selected note's positions and the notes being played; clicking a fret plays the pitch and highlights matching notes in the score.
- **Export**: Guitar Pro 5 (`.gp5`), Guitar Pro 7+ (`.gp`), MIDI, ASCII tab (4 bars per line, aligned columns, also copy to clipboard), PNG, and Print/PDF through the browser print stylesheet.
- Thai and English UI, light and dark theme, responsive down to phone width, keyboard navigation (← → between notes, Space to play/pause), installable PWA that works offline.

## Quick start

```bash
npm install
npm run dev        # http://localhost:5173  (try /?demo=aura-lee)
npm test           # Vitest: theory module + end-to-end pipeline
npm run build      # static site in dist/
```

For GitHub Pages the `base` path must match the repository name. Set `BASE_PATH` at build time:

```bash
BASE_PATH=/staff-lens/ npm run build
```

The default (`./`) gives a relocatable build. The included workflow (`.github/workflows/deploy.yml`) tests, builds with `BASE_PATH=/<repo>/` and deploys to Pages on every push to `main`. alphaTab's font, SoundFont and worker files are resolved from `import.meta.env.BASE_URL`, so they work under a sub-path.

## How staff → tab works

All theory lives in [`src/theory/`](src/theory), pure TypeScript with no alphaTab dependency, covered by unit tests.

The optimizer ([`src/theory/optimizer.ts`](src/theory/optimizer.ts)) treats each attack (a single note or a chord) as one step. For each note, the candidates are every `(string, fret)` that produces the pitch in the current tuning, with frets in `[capo, maxFret]`. A state is "positions for the notes of this step + hand position" (the fret under the index finger). Chords pick a set of distinct strings. A Viterbi pass picks the cheapest path through all steps:

| Cost term | Meaning |
|---|---|
| `shift`, `shiftBase` | hand movement between steps |
| `stretch` | notes outside the 4-fret span of the hand |
| `stringSkip` | jumping over strings between melody notes |
| `openBonus` | reward for open strings (strong in Open position mode) |
| `highFret` (+ beginner) | penalty above fret 4 in beginner mode |
| `anchor` | distance from 1st position, or from N in "Stay in position N" |

Weights per mode are in `MODE_WEIGHTS` and can be tuned in code. Locked notes have a single candidate, so the path is planned around them. Tied notes copy their origin's position.

Guitar convention: a guitar plays what is written and it sounds an octave lower. StaffLens therefore uses *written pitch − 12* as the guitar pitch for every part (shifted by any octave change you apply). For the Aura Lee fixture in Open position mode the optimizer produces exactly D4→4:0, E4→4:2, F♯4→4:4, G4→3:0, A4→3:2, B4→2:0, C5→2:1 (asserted in `tests/theory.test.ts` and, through the real MusicXML file, in `tests/pipeline.test.ts`).

## Export: why `.gp5` is written by StaffLens itself

The collection hands files from tool to tool as `.gp5`. alphaTab 1.9.0 only exports Guitar Pro 7 (`.gp`) and alphaTex. Of the two options in the spec, StaffLens uses **(b)**: the GP5 writer from TabLens (`src/gp5writer.js`, a port of the PyGuitarPro write path) is ported to TypeScript in [`src/export/gp5writer.ts`](src/export/gp5writer.ts) and extended with key signatures, volta endings and a second voice. The tests write Aura Lee to `.gp5` and read it back with alphaTab's GP5 importer: notes, strings/frets, durations, repeats, sections, key and chord symbols all round-trip. `.gp` (GP7, via alphaTab) is offered as a second option. Option (a), whether Riff Forge and Tempo Bench accept `.gp`, was not checked.

Notes on the GP5 output:
- Chord symbols are stored as beat text (as in TabLens). StaffLens reads them back as chords.
- GP5 stores text in a Latin code page, so Thai titles become `?` (same as TabLens).
- Voices 1 and 2 are written; grace notes are left out.

## Project layout

```
src/
  theory/        pure music theory: pitch, intervals, keys, accidentals, durations, chords,
                 chord shapes, fretboard, optimizer, repeats/play order, arranging, ASCII tab
  model/         internal score model (score.ts), alphaTab → model, MusicXML <harmony> reader,
                 arrangement (staff → tab), model → alphaTab render score
  explain/       plain-language panels (overview, note, chord)
  export/        GP5 writer, GP5/ASCII exporters
  ui/            fretboard, SVG drawings, tab/export forms
  i18n/          English and Thai strings
  app.ts         application controller (alphaTab, playback, selection, panels)
public/samples/  aura-lee.musicxml, chord-study.musicxml (generated by tools/make-samples.mjs)
public/sw.js     offline service worker
tests/           Vitest unit + pipeline tests, Aura Lee fixture
```

### Ready for later phases

- **Phase 2 (OMR)**: `src/model/score.ts` is the internal score model. File import already converts into it (`fromAlphaTab`), and everything downstream (explanations, optimizer, exports) reads only the model, so OMR output can convert into the same model. The "Image / PDF" entry is already in the header, disabled.
- **Phase 3 (practice)**: the theory module (pitch naming, fretboard positions, intervals) is UI-independent and can drive quizzes and drills.

### Known limitations

- Chord symbols are read straight from the MusicXML `<harmony>` elements (also inside `.mxl`, unzipped in the browser), so slash chords keep their bass note. Guitar Pro files use alphaTab's chords or chord-like beat text.
- The chord accompaniment is a simple down-strum on every beat using the first chord shape.
- After a D.C./D.S. jump, repeats are not taken again (the common convention).
- The PNG export uses the current theme's colours.
- Playback depends on the browser allowing audio; the first play may need a click.

## Add StaffLens to the collection

Row for the landing table in `unknown-guitar-toolkits`:

```markdown
| [StaffLens](https://un4ckn0wl3z.github.io/staff-lens/) | Standard notation (MusicXML / Guitar Pro) → plain-language explanations, playback and optimized guitar tab; exports `.gp5` | `staff image/PDF/MusicXML → StaffLens → .gp5 → Riff Forge → Tempo Bench` |
```

## Credits

- [alphaTab](https://alphatab.net) (MPL-2.0) for rendering, playback and file import.
- Bravura music font (SIL OFL 1.1) and the Sonivox SoundFont (Apache-2.0), both shipped with alphaTab.
- GP5 writer ported from [TabLens](https://github.com/un4ckn0wl3z/TabLens).
- *Aura Lee*: music by George R. Poulton, words by W. W. Fosdick (1861), public domain.

---

## ภาษาไทย

StaffLens เป็นเครื่องมือหนึ่งในชุด [Unknown Guitar Toolkits](https://github.com/un4ckn0wl3z/unknown-guitar-toolkits) และเป็นคู่กับ [TabLens](https://github.com/un4ckn0wl3z/TabLens): TabLens แปลงรูปแท็บเป็นไฟล์ Guitar Pro ส่วน StaffLens รับ **โน้ตสากล** มาอธิบายด้วยภาษาง่าย ๆ เล่นเสียงให้ฟัง และแปลงเป็น **แท็บกีตาร์**

ทุกอย่างทำงานในเบราว์เซอร์ ไม่มีเซิร์ฟเวอร์ ไม่อัปโหลดไฟล์ ไม่เก็บข้อมูลการใช้งาน และใช้งานออฟไลน์ได้หลังเปิดครั้งแรก

```
รูป/PDF/MusicXML ของโน้ตสากล → StaffLens → .gp5 → Riff Forge → Tempo Bench
```

### ทำอะไรได้บ้าง (เฟส 1)

- **เปิดไฟล์** MusicXML, MXL และ Guitar Pro (.gp, .gpx, .gp5, .gp4, .gp3) ด้วยปุ่มหรือการลากวาง มีเพลงตัวอย่าง *Aura Lee* (สาธารณสมบัติ ปี 1861) และแบบฝึกคอร์ด ส่วนการอ่านรูปภาพ/PDF จะมาในเฟส 2
- **แสดงโน้ตและแท็บคู่กัน** สลับดูเฉพาะโน้ต เฉพาะแท็บ หรือทั้งสองอย่างได้ เคอร์เซอร์เล่นตามทั้งสองบรรทัดและเลื่อนหน้าจอให้อัตโนมัติ
- **ภาพรวมเพลง**: กุญแจประจำหลัก เครื่องหมายประจำกุญแจและคีย์ที่น่าจะเป็นพร้อมเหตุผล เครื่องหมายกำหนดจังหวะ ความเร็ว ท่อนเพลง เครื่องหมายย้อน/วงเล็บจบ/D.C./D.S./Coda/Fine และ **ลำดับห้องที่เล่นจริง**
- **คลิกโน้ต** เพื่อฟังเสียงและดูชื่อโน้ต (ที่เขียนและเสียงจริง) ความยาว จังหวะที่เริ่ม ที่มาของชาร์ป/แฟลต ขั้นคู่จากโน้ตก่อนหน้า ขั้นในบันไดเสียง บทบาทเทียบกับคอร์ด และ **ตำแหน่งบนคอกีตาร์ทุกจุด** พร้อมนิ้วที่แนะนำ มีโหมดมือใหม่/ละเอียด
- **คลิกคอร์ด** เพื่อฟังแบบตีคอร์ดหรือเกา ดูสูตรและโน้ตในคอร์ด ความหมายของสัญลักษณ์ หน้าที่ในคีย์ และผังการจับคอร์ด
- **แปลงโน้ตเป็นแท็บ** ด้วยตัวปรับตำแหน่งนิ้ว เลือกโหมดตำแหน่งสายเปล่า/อยู่ที่ตำแหน่ง N/ย้ายมือน้อยที่สุด ตั้งสายได้ 4 แบบ ใส่คาโป้ 0–9 **ล็อกโน้ต** ได้โดยคลิกตัวเลขในแท็บ ตรวจช่วงเสียงและเลื่อนอ็อกเทฟ และเพิ่มเบสจากคอร์ดแบบฟิงเกอร์สไตล์ง่าย ๆ
- **เล่นเสียง**: เล่น/หยุด เล่นจากโน้ตที่เลือก วนห้อง ปรับความเร็ว 50–150% โดยเสียงไม่เพี้ยน เมโทรนอม นับนำ คอร์ดประกอบ เลือกเสียงกีตาร์สายไนลอนหรือสายเหล็ก
- **คอกีตาร์แบบโต้ตอบ** ใต้บรรทัดโน้ต คลิกเฟร็ตเพื่อฟังเสียงและหาโน้ตเสียงนั้นในเพลง
- **ส่งออก** เป็น .gp5, .gp, MIDI, แท็บข้อความ, PNG และพิมพ์/PDF
- หน้าจอภาษาไทยและอังกฤษ ธีมสว่างและมืด ใช้บนมือถือได้ ใช้คีย์บอร์ดได้ (← → เลื่อนโน้ต, Space เล่น/หยุด)

### เริ่มใช้งาน

```bash
npm install
npm run dev
npm test
BASE_PATH=/staff-lens/ npm run build
```

### ทำไมเขียนไฟล์ .gp5 เอง

alphaTab 1.9.0 ส่งออกได้แค่ Guitar Pro 7 (.gp) จึงนำตัวเขียน GP5 ของ TabLens มาแปลงเป็น TypeScript และเพิ่มเครื่องหมายประจำกุญแจ วงเล็บจบ และเสียงที่สอง ทดสอบโดยเขียนไฟล์แล้วให้ alphaTab อ่านกลับมาตรวจ ข้อจำกัดเหมือน TabLens คือ GP5 เก็บข้อความแบบอักษรละติน ชื่อเพลงภาษาไทยจะกลายเป็น `?` และยังมีตัวเลือกส่งออกเป็น .gp ด้วย

รายละเอียดวิธีทำงานของตัวปรับตำแหน่งนิ้ว โครงสร้างโปรเจกต์ และข้อจำกัด ดูในส่วนภาษาอังกฤษด้านบน
