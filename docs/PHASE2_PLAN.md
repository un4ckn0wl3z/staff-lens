# Phase 2 — OMR (image / PDF → score)

Goal: open a photo, scan or PDF of standard notation, recognise it in the browser, let the user fix mistakes, then use every Phase 1 feature (explanations, playback, staff → tab, export) on the result.

Decision (2026-11-12): use **oemer's ONNX models with onnxruntime-web**, and **port oemer's post-processing to TypeScript**. oemer is MIT-licensed (https://github.com/BreezeWhite/oemer).

Work happens on the `phase-2` branch; `main` auto-deploys, so merge only when image → score works end to end.

## Pipeline

```
file (jpg/png/webp/pdf)
  → pdf.js page render (PDF)           src/omr/imageInput.ts
  → rotate / crop / deskew / perspective src/omr/geometry.ts  (pure, tested)
  → resize to ~3.0–4.35 MP (as oemer)
  → UNet "1st_model" (staff, symbols)    onnxruntime-web in a Web Worker,
  → SegNet "2nd_model" (stems, noteheads, clefs…)  WebGPU if available, else WASM
  → post-processing (port of oemer)     src/omr/oemer/*.ts
       staffline → notehead → note groups → symbols → rhythm → build system
  → SLScore (src/model/score.ts) with per-note confidence
  → chord-symbol OCR (Tesseract.js) on the band above each staff
  → note editor to correct → render / play / tab / export as in Phase 1
```

## Milestones

| # | Milestone | Depends on | Status |
|---|---|---|---|
| M1 | Image/PDF input; rotate, crop, auto-deskew, 4-corner perspective correction; scan view UI | — | done |
| M2 | Score from model: build an alphaTab score directly from `SLScore` (no source file); note editor (pitch ↑↓, duration, accidental, rest, insert/delete, chord symbols, undo); confidence highlighting | — | |
| M3 | Models: fetch `1st_model.onnx` (71 MB) and `2nd_model.onnx` (38 MB) from the oemer `checkpoints` release in CI and in `npm run fetch-models` (pinned SHA-256, not stored in git); onnxruntime-web worker with sliding-window inference (window 256, step 128) and progress; cache for offline | — | |
| M4 | Port post-processing: staff lines, noteheads, note groups, symbols (clef/accidental/rest classifiers converted from oemer's scikit-learn models), rhythm, system building → `SLScore` | M3 | |
| M5 | Chord-symbol OCR with Tesseract.js, parsed with `parseChordSymbol`; low-confidence marking | M2, M4 | |
| M6 | Fixtures and tests: rendered Aura Lee page and a phone-photo fixture; per-stage unit tests; end-to-end note accuracy check | M4 | |

M1, M2 and M3 are independent of each other.

## Notes and risks

- Model size: ~110 MB downloaded on first OMR use only (not on page load), then cached by the service worker. Possible later: int8 quantisation in CI to shrink it.
- Speed: ~250+ windows per model per page. WASM may take minutes; WebGPU much less. Run in a worker with progress and cancel.
- oemer's `resize_image` check `3000000 <= pis <= 435000` is never true, so oemer always resizes; the port does the same.
- oemer's scikit-learn classifiers (`clef`, `sfn`, `rests`, `rests_above8`) are pickled; they must be converted (e.g. to JSON weights or ONNX via skl2onnx) once, with the conversion script kept in `tools/`.
- Licences: oemer MIT, onnxruntime-web MIT, pdf.js Apache-2.0, Tesseract.js Apache-2.0.
