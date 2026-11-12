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
| M3 | Models: fetch `1st_model.onnx` (71 MB) and `2nd_model.onnx` (38 MB) from the oemer `checkpoints` release in CI and in `npm run fetch-models` (pinned SHA-256, not stored in git); onnxruntime-web worker with sliding-window inference (window 256, step 128) and progress; cache for offline | — | done |
| M4 | Port post-processing: staff lines, noteheads, note groups, symbols (clef/accidental/rest classifiers converted from oemer's scikit-learn models), rhythm, system building → `SLScore` | M3 | in progress: staff lines ✓, noteheads ✓ |
| M5 | Chord-symbol OCR with Tesseract.js, parsed with `parseChordSymbol`; low-confidence marking | M2, M4 | |
| M6 | Fixtures and tests: rendered Aura Lee page and a phone-photo fixture; per-stage unit tests; end-to-end note accuracy check | M4 | |

M1, M2 and M3 are independent of each other.

## M3 results (2026-11-12)

- Model I/O (checked with onnxruntime-web): input `uint8` NHWC, **BGR** channel order (oemer reads with OpenCV).
  1st model: window 256, 3 classes (bg, staff, symbols). 2nd model: window **288**, 4 classes (bg, stems/rests, noteheads, clefs/keys).
- `npm run fetch-models` downloads both files with pinned SHA-256; CI caches them (`actions/cache`).
- Inference runs in `src/omr/inference.worker.ts`; WebGPU first, WASM fallback. The page is cross-origin isolated
  (dev/preview headers, and the service worker on GitHub Pages), so WASM uses up to 8 threads.
- Measured on the rendered Aura Lee page (resized to 1408×2610, "fast" quality, 84 + 66 windows):
  WebGPU ≈ 0.65 s/window, 157 s in total including the first download; WASM × 8 threads is about as fast here;
  WASM × 1 thread ≈ 4 s (model 1) and 8 s (model 2) per window.
- The scan view shows the detected layers (staff, symbols, noteheads, stems/rests, clefs/keys) as a coloured overlay;
  the result is kept on `App.omr` for M4.

## M4 method and progress

- `tools/oemer_reference.py` runs the real oemer 0.1.8 step by step on `tests/fixtures/omr/aura-lee-staff.png`
  (oemer's own inference, accurate step 128, no dewarp) and dumps the model maps (`maps.u8.gz`, bit-packed) and every
  intermediate result (`reference.json`) plus oemer's MusicXML. Needs a venv with `oemer==0.1.8`, `onnxruntime==1.16.3`,
  `numpy<2`, `opencv-python-headless<4.10`, `scikit-learn<1.6`, `scipy<1.14` (newer onnxruntime rejects model 1).
- `tools/omr_golden.py` generates golden cases from OpenCV/scipy/sklearn/CPython for the primitives in
  `src/omr/oemer/cv.ts` and `pyport.ts`: find_peaks, erode/dilate, ellipse kernels, ndimage.label, findContours order,
  HoughLinesP (with cv::RNG), Ward clustering labels, `set.pop()` order, numpy pairwise sums. All match exactly
  (find_peaks ties in the distance filter follow numpy's unstable argsort and are excluded).
- oemer on the clean Aura Lee page: 12/12 bars, key and clef right; errors: 2 extra notes in bar 1 (tempo mark),
  bar 2 misses the half note. The port aims to reproduce oemer exactly, then improve.
- Ported and matching oemer exactly: staff-line extraction (`staffline.ts`), notehead extraction (`notehead.ts`).
- Next: note groups, symbols (barlines, clefs, accidentals, rests — convert oemer's scikit-learn classifiers),
  rhythm, system building → `SLScore`.

## Notes and risks

- Model size: ~110 MB downloaded on first OMR use only (not on page load), then cached by the service worker. Possible later: int8 quantisation in CI to shrink it.
- Speed: ~250+ windows per model per page. WASM may take minutes; WebGPU much less. Run in a worker with progress and cancel.
- oemer's `resize_image` check `3000000 <= pis <= 435000` is never true, so oemer always resizes; the port does the same.
- oemer's scikit-learn classifiers (`clef`, `sfn`, `rests`, `rests_above8`) are pickled; they must be converted (e.g. to JSON weights or ONNX via skl2onnx) once, with the conversion script kept in `tools/`.
- Licences: oemer MIT, onnxruntime-web MIT, pdf.js Apache-2.0, Tesseract.js Apache-2.0.
