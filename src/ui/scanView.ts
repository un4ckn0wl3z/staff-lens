// Scan view: prepare a photo, scan or PDF page for recognition.
// Rotate in quarter turns, auto-straighten (staff-line skew), drag four corners to fix perspective.

import { esc } from '../explain/format';
import { t } from '../i18n';
import { clearEdgeBands, estimateSkew, isFullQuad, rectifiedSize, rotate, rotate90, toGray, warpPerspective, type Img, type Pt } from '../omr/geometry';
import { drawImg, loadImageFile, openPdf, type PdfHandle } from '../omr/imageInput';
import { LAYER_COLORS, OmrRunner, overlayImage, type ProgressInfo, type Segmentation } from '../omr/runner';
import { createTesseractEngine, pngCropper, readTempoMark, recognizeChords, type ChordHit } from '../omr/chordOcr';
import type { Quality } from '../omr/tiling';
import type { StringKey } from '../i18n';

export interface ScanResult {
  image: Img;
  fileName: string;
  page: number;
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class ScanView {
  private root: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private svg!: SVGSVGElement;
  private pdf: PdfHandle | null = null;
  private fileName = '';
  private page = 0;
  private original: Img | null = null;
  private quarter = 0;
  private skew = 0;
  private straight: Img | null = null;
  private corners: Pt[] = [];
  private preview = false;
  private busy = false;
  private drag: { index: number; pointerId: number } | null = null;
  private runner = new OmrRunner();
  private quality: Quality = 'fast';
  private seg: Segmentation | null = null;
  private showSeg = false;
  private layers = new Set(LAYER_COLORS.map((l) => l.key));
  private inferStart = 0;

  constructor(
    private toast: (msg: string, error?: boolean) => void,
    private onSegmented: ((r: ScanResult, seg: Segmentation) => void) | null = null,
    private onOpen: ((musicxml: string, fileName: string, chords: ChordHit[], tempo: number | null) => void) | null = null,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'scan-view';
    this.root.hidden = true;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    document.body.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-scan]');
      if (el) void this.action(el.dataset.scan!, el);
    });
    this.root.addEventListener('change', (e) => {
      const el = e.target as HTMLSelectElement;
      if (el.name === 'scan-page') void this.loadPage(Number(el.value));
      if (el.name === 'quality') this.quality = el.value as Quality;
      if (el.name === 'layer') {
        const cb = el as unknown as HTMLInputElement;
        if (cb.checked) this.layers.add(cb.value);
        else this.layers.delete(cb.value);
        this.drawSeg();
      }
    });
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  async open(file: File): Promise<void> {
    this.close();
    this.fileName = file.name;
    this.root.hidden = false;
    document.body.classList.add('scanning');
    this.renderShell();
    this.setBusy(true);
    try {
      if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
        this.pdf = await openPdf(new Uint8Array(await file.arrayBuffer()));
        this.renderShell();
        await this.loadPage(0);
      } else {
        this.original = await loadImageFile(file);
        this.resetGeometry();
        await this.rebuild();
      }
    } catch (e) {
      this.toast(t('scan.error', { msg: (e as Error).message }), true);
      this.close();
    } finally {
      this.setBusy(false);
    }
  }

  close(): void {
    this.runner.cancel();
    this.seg = null;
    this.showSeg = false;
    this.pdf?.destroy();
    this.pdf = null;
    this.original = null;
    this.straight = null;
    this.root.hidden = true;
    this.root.innerHTML = '';
    document.body.classList.remove('scanning');
  }

  private async loadPage(index: number): Promise<void> {
    if (!this.pdf) return;
    this.setBusy(true);
    try {
      this.page = index;
      this.original = await this.pdf.renderPage(index);
      this.resetGeometry();
      await this.rebuild();
    } finally {
      this.setBusy(false);
    }
  }

  private resetGeometry(): void {
    this.quarter = 0;
    this.skew = 0;
    this.corners = [];
    this.preview = false;
    this.seg = null;
    this.showSeg = false;
  }

  /** Recomputes the rotated / straightened image; corners are reset to the full image. */
  private async rebuild(keepCorners = false): Promise<void> {
    if (!this.original) return;
    this.setBusy(true);
    await nextFrame();
    let img = rotate90(this.original, this.quarter);
    if (this.skew) img = rotate(img, -this.skew);
    this.straight = img;
    if (!keepCorners || this.corners.length !== 4) {
      this.corners = [
        { x: 0, y: 0 },
        { x: img.width - 1, y: 0 },
        { x: img.width - 1, y: img.height - 1 },
        { x: 0, y: img.height - 1 },
      ];
    }
    this.preview = false;
    this.seg = null;
    this.showSeg = false;
    this.draw();
    this.setBusy(false);
  }

  private result(): Img | null {
    if (!this.straight) return null;
    if (isFullQuad(this.corners, this.straight.width, this.straight.height)) return clearEdgeBands(this.straight);
    return clearEdgeBands(warpPerspective(this.straight, this.corners, rectifiedSize(this.corners, this.straight.width, this.straight.height)));
  }

  private async action(name: string, _el: HTMLElement): Promise<void> {
    if (this.busy && name !== 'close' && name !== 'cancel') return;
    switch (name) {
      case 'close':
        this.close();
        break;
      case 'rot-left':
      case 'rot-right':
        this.quarter = (this.quarter + (name === 'rot-right' ? 1 : 3)) % 4;
        this.skew = 0;
        await this.rebuild();
        break;
      case 'straighten': {
        if (!this.original) break;
        this.setBusy(true);
        await nextFrame();
        const base = rotate90(this.original, this.quarter);
        this.skew = estimateSkew(base);
        await this.rebuild();
        this.status(t('scan.straightened', { deg: this.skew.toFixed(2) }));
        break;
      }
      case 'reset':
        this.resetGeometry();
        await this.rebuild();
        break;
      case 'preview':
        this.setBusy(true);
        await nextFrame();
        this.preview = !this.preview;
        this.draw();
        this.setBusy(false);
        break;
      case 'recognize':
        await this.recognize();
        break;
      case 'cancel':
        this.runner.cancel();
        break;
      case 'back':
        this.showSeg = false;
        this.draw();
        break;
      case 'open':
        if (this.seg?.musicxml && this.onOpen) {
          const name = this.fileName.replace(/\.[^.]+$/, '') + (this.pdf ? `-p${this.page + 1}` : '') + '.musicxml';
          const xml = this.seg.musicxml;
          const chords = this.seg.chords;
          const tempo = this.seg.tempo;
          this.close();
          this.onOpen(xml, name, chords, tempo);
        }
        break;
      case 'show-seg':
        this.showSeg = true;
        this.drawSeg();
        break;
    }
  }

  // ------------------------------------------------------------ rendering

  private renderShell(): void {
    const pages = this.pdf
      ? `<label class="field inline"><span>${esc(t('scan.page'))}</span><select name="scan-page">${Array.from(
          { length: this.pdf.pageCount },
          (_, i) => `<option value="${i}" ${i === this.page ? 'selected' : ''}>${i + 1} / ${this.pdf!.pageCount}</option>`,
        ).join('')}</select></label>`
      : '';
    const layerBoxes = LAYER_COLORS.map(
      (l) =>
        `<label class="check layer"><input type="checkbox" name="layer" value="${l.key}" ${this.layers.has(l.key) ? 'checked' : ''}><span class="swatch" style="background:rgb(${l.rgb.join(',')})"></span>${esc(t(`omr.layer.${l.key}` as StringKey))}</label>`,
    ).join('');
    this.root.innerHTML = `
      <div class="scan-head">
        <h2>${esc(t('scan.title'))}</h2>
        <span class="muted small scan-file">${esc(this.fileName)}</span>
        <button class="btn ghost icon" data-scan="close" aria-label="${esc(t('common.close'))}" title="${esc(t('common.close'))}">✕</button>
      </div>
      <div class="scan-tools">
        ${pages}
        <button class="btn" data-scan="rot-left" title="${esc(t('scan.rotLeft'))}" aria-label="${esc(t('scan.rotLeft'))}">⟲</button>
        <button class="btn" data-scan="rot-right" title="${esc(t('scan.rotRight'))}" aria-label="${esc(t('scan.rotRight'))}">⟳</button>
        <button class="btn" data-scan="straighten">${esc(t('scan.straighten'))}</button>
        <button class="btn" data-scan="preview" aria-pressed="false">${esc(t('scan.preview'))}</button>
        <button class="btn ghost" data-scan="reset">${esc(t('scan.reset'))}</button>
        <span class="spacer"></span>
        <label class="field inline"><span>${esc(t('omr.quality'))}</span><select name="quality">
          <option value="fast" ${this.quality === 'fast' ? 'selected' : ''}>${esc(t('omr.fast'))}</option>
          <option value="accurate" ${this.quality === 'accurate' ? 'selected' : ''}>${esc(t('omr.accurate'))}</option>
        </select></label>
        <button class="btn primary" data-scan="recognize">${esc(t('scan.recognize'))}</button>
      </div>
      <p class="muted small scan-hint">${esc(t('scan.hint'))}</p>
      <div class="scan-progress" hidden>
        <progress max="1" value="0"></progress>
        <span class="small progress-label" aria-live="polite"></span>
        <button class="btn small" data-scan="cancel">${esc(t('omr.cancel'))}</button>
      </div>
      <div class="scan-layers" hidden>
        ${layerBoxes}
        <button class="btn small" data-scan="back">${esc(t('omr.back'))}</button>
        <button class="btn small" data-scan="show-seg">${esc(t('omr.showSeg'))}</button>
        <button class="btn primary" data-scan="open" hidden>${esc(t('omr.open'))}</button>
      </div>
      <div class="scan-stage"><div class="scan-frame"><canvas></canvas><svg class="scan-overlay"></svg></div></div>
      <p class="muted small scan-status" aria-live="polite"></p>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.svg = this.root.querySelector('svg')!;
    this.bindHandles();
    (this.root.querySelector('[data-scan="close"]') as HTMLElement).focus();
  }

  private setBusy(on: boolean): void {
    this.busy = on;
    this.root.classList.toggle('busy', on);
  }

  private status(msg: string): void {
    const el = this.root.querySelector('.scan-status');
    if (el) el.textContent = msg;
  }

  private async recognize(): Promise<void> {
    let image = this.result();
    if (!image) return;
    // oemer finds staff lines only when they are close to horizontal: straighten what is left after the corners
    const tilt = estimateSkew(image);
    if (Math.abs(tilt) >= 1) {
      image = clearEdgeBands(rotate(image, -tilt));
      this.status(t('scan.straightened', { deg: tilt.toFixed(2) }));
    }
    const progress = this.root.querySelector<HTMLElement>('.scan-progress')!;
    const bar = progress.querySelector('progress')!;
    const label = progress.querySelector<HTMLElement>('.progress-label')!;
    progress.hidden = false;
    this.root.querySelector<HTMLElement>('.scan-layers')!.hidden = true;
    this.root.classList.add('running');
    this.inferStart = 0;
    const started = performance.now();
    try {
      const title = this.fileName.replace(/\.[^.]+$/, '') + (this.pdf ? ` (${this.page + 1})` : '');
      const seg = await this.runner.run(image, this.quality, (p) => this.onProgress(p, bar, label), title);
      this.seg = seg;
      this.showSeg = true;
      this.drawSeg();
      const how = seg.provider === 'webgpu' ? 'WebGPU' : `WASM × ${seg.threads}`;
      const openBtn = this.root.querySelector<HTMLButtonElement>('[data-scan="open"]')!;
      if (seg.musicxml && seg.notes > 0 && seg.systems.length) {
        progress.hidden = false;
        label.textContent = t('omr.building', { step: t('omr.step.chords') });
        seg.chords = await this.readChords(seg, image);
      }
      const secs = Math.round((performance.now() - started) / 1000);
      if (seg.musicxml && seg.notes > 0) {
        this.status(t('omr.found', { notes: seg.notes, bars: seg.bars, s: secs, provider: how }) + ' ' + t('omr.foundChords', { n: seg.chords.length }) + (seg.tempo ? ' ' + t('omr.foundTempo', { bpm: seg.tempo }) : ''));
        openBtn.hidden = false;
        openBtn.focus();
      } else {
        this.status(seg.error === 'no staff lines found' ? t('omr.noStaff') : seg.error ? t('omr.buildError', { msg: seg.error }) : t('omr.noNotes'));
        openBtn.hidden = true;
      }
      this.onSegmented?.({ image, fileName: this.fileName, page: this.page }, seg);
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'cancelled') this.status(t('omr.cancelled'));
      else this.toast(t('omr.error', { msg }), true);
    } finally {
      progress.hidden = true;
      this.root.classList.remove('running');
    }
  }

  /**
   * Chord-symbol OCR (Tesseract.js, self-hosted files in /ocr/). Reads the prepared page at its own resolution, not
   * oemer's resampled copy: resampling blurs small italic text.
   */
  private async readChords(seg: Segmentation, page: Img): Promise<ChordHit[]> {
    try {
      const { width, height, data } = page;
      const imageData = new ImageData(new Uint8ClampedArray(data), width, height);
      const base = new URL(import.meta.env.BASE_URL, location.href).href;
      const engine = await createTesseractEngine(pngCropper(imageData), { workerPath: `${base}ocr/worker.min.js`, corePath: `${base}ocr/core/`, langPath: `${base}ocr/lang` });
      try {
        const scale = width / seg.image.width;
        const chords = await recognizeChords(engine, toGray(page), width, height, seg.systems, seg.timeline, scale);
        if (seg.tempoNote) seg.tempo = await readTempoMark(engine, seg.tempoNote, seg.systems[0]?.unit ?? 20, width, height, scale).catch(() => null);
        return chords;
      } finally {
        await engine.terminate();
      }
    } catch (e) {
      console.warn('chord OCR failed', e);
      return [];
    }
  }

  private onProgress(p: ProgressInfo, bar: HTMLProgressElement, label: HTMLElement): void {
    const model = p.model + 1;
    // overall: each model = 15% download/load + 85% inference; reading the notes is the last 5%
    const share = (frac: number) => ((p.model + frac) / 2) * 0.95;
    if (p.stage === 'notes') {
      bar.value = 0.95 + (0.05 * p.done) / Math.max(1, p.total);
      label.textContent = t('omr.building', { step: t(`omr.step.${p.step}` as StringKey) });
    } else if (p.stage === 'download') {
      bar.value = share(p.total ? (0.15 * p.done) / p.total : 0);
      label.textContent = t('omr.download', { model, mb: (p.done / 1e6).toFixed(0), total: p.total ? (p.total / 1e6).toFixed(0) : '?' });
    } else if (p.stage === 'load') {
      bar.value = share(0.15);
      label.textContent = t('omr.load', { model });
    } else {
      if (p.done === 0) this.inferStart = performance.now();
      bar.value = share(0.15 + (0.85 * p.done) / Math.max(1, p.total));
      let eta = '';
      if (p.done > 0) {
        const per = (performance.now() - this.inferStart) / p.done;
        eta = ' · ' + t('omr.eta', { s: Math.max(1, Math.round((per * (p.total - p.done)) / 1000)) });
      }
      const how = p.provider === 'webgpu' ? 'WebGPU' : `WASM × ${p.threads ?? 1}`;
      label.textContent = t('omr.infer', { model, done: p.done, total: p.total, how }) + eta;
      if (p.provider === 'wasm' && (p.threads ?? 1) === 1 && p.done === 0) this.status(t('omr.slowHint'));
    }
  }

  private drawSeg(): void {
    if (!this.seg || !this.showSeg) return;
    drawImg(this.canvas, overlayImage(this.seg, this.layers));
    this.svg.setAttribute('viewBox', `0 0 ${this.seg.image.width} ${this.seg.image.height}`);
    this.svg.innerHTML = '';
    const layersEl = this.root.querySelector<HTMLElement>('.scan-layers');
    if (layersEl) layersEl.hidden = false;
  }

  private draw(): void {
    if (!this.straight) return;
    const layersEl = this.root.querySelector<HTMLElement>('.scan-layers');
    if (layersEl) layersEl.hidden = !this.seg;
    const shown = this.preview ? this.result()! : this.straight;
    drawImg(this.canvas, shown);
    this.root.querySelector('[data-scan="preview"]')?.setAttribute('aria-pressed', String(this.preview));
    this.svg.setAttribute('viewBox', `0 0 ${shown.width} ${shown.height}`);
    this.drawHandles();
    this.status(`${shown.width} × ${shown.height} px` + (this.skew ? ` · ${t('scan.straightened', { deg: this.skew.toFixed(2) })}` : ''));
  }

  private drawHandles(): void {
    if (this.preview || !this.straight) {
      this.svg.innerHTML = '';
      return;
    }
    const scale = this.straight.width / Math.max(1, this.canvas.getBoundingClientRect().width || this.straight.width);
    const r = 14 * scale;
    const pts = this.corners.map((p) => `${p.x},${p.y}`).join(' ');
    const labels = [t('scan.cornerTL'), t('scan.cornerTR'), t('scan.cornerBR'), t('scan.cornerBL')];
    this.svg.innerHTML =
      `<polygon class="scan-quad" points="${pts}" style="stroke-width:${2 * scale}px"/>` +
      this.corners
        .map(
          (p, i) =>
            `<circle class="scan-handle" data-corner="${i}" cx="${p.x}" cy="${p.y}" r="${r}" style="stroke-width:${2 * scale}px" tabindex="0" role="slider" aria-label="${esc(labels[i])}"/>`,
        )
        .join('');
  }

  private toImage(e: PointerEvent): Pt {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.straight!.width / rect.width;
    const sy = this.straight!.height / rect.height;
    return {
      x: Math.max(0, Math.min(this.straight!.width - 1, (e.clientX - rect.left) * sx)),
      y: Math.max(0, Math.min(this.straight!.height - 1, (e.clientY - rect.top) * sy)),
    };
  }

  private bindHandles(): void {
    this.svg.addEventListener('pointerdown', (e) => {
      const h = (e.target as Element).closest('[data-corner]') as SVGElement | null;
      if (!h || !this.straight) return;
      e.preventDefault();
      this.drag = { index: Number(h.dataset.corner), pointerId: e.pointerId };
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', (e) => {
      if (!this.drag || e.pointerId !== this.drag.pointerId) return;
      this.corners[this.drag.index] = this.toImage(e);
      this.drawHandles();
    });
    const end = (e: PointerEvent) => {
      if (this.drag && e.pointerId === this.drag.pointerId) this.drag = null;
    };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointercancel', end);
    this.svg.addEventListener('keydown', (e) => {
      const h = (e.target as Element).closest('[data-corner]') as SVGElement | null;
      if (!h || !this.straight) return;
      const step = e.shiftKey ? 20 : 4;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const mv = d[e.key];
      if (!mv) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(h.dataset.corner);
      const p = this.corners[i];
      this.corners[i] = {
        x: Math.max(0, Math.min(this.straight.width - 1, p.x + mv[0])),
        y: Math.max(0, Math.min(this.straight.height - 1, p.y + mv[1])),
      };
      this.drawHandles();
      (this.svg.querySelector(`[data-corner="${i}"]`) as SVGElement | null)?.focus();
    });
  }
}
