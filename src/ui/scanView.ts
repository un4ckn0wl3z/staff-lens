// Scan view: prepare a photo, scan or PDF page for recognition.
// Rotate in quarter turns, auto-straighten (staff-line skew), drag four corners to fix perspective.

import { esc } from '../explain/format';
import { t } from '../i18n';
import { estimateSkew, isFullQuad, rotate, rotate90, warpPerspective, type Img, type Pt } from '../omr/geometry';
import { drawImg, loadImageFile, openPdf, type PdfHandle } from '../omr/imageInput';

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

  constructor(
    private toast: (msg: string, error?: boolean) => void,
    private onRecognize: ((r: ScanResult) => void) | null,
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
    this.pdf?.destroy();
    this.pdf = null;
    this.original = null;
    this.straight = null;
    this.root.hidden = true;
    this.root.innerHTML = '';
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
    this.draw();
    this.setBusy(false);
  }

  private result(): Img | null {
    if (!this.straight) return null;
    if (isFullQuad(this.corners, this.straight.width, this.straight.height)) return this.straight;
    return warpPerspective(this.straight, this.corners);
  }

  private async action(name: string, _el: HTMLElement): Promise<void> {
    if (this.busy && name !== 'close') return;
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
      case 'recognize': {
        const image = this.result();
        if (image && this.onRecognize) this.onRecognize({ image, fileName: this.fileName, page: this.page });
        break;
      }
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
    const canRecognize = !!this.onRecognize;
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
        <button class="btn primary" data-scan="recognize" ${canRecognize ? '' : 'disabled'}>${esc(t('scan.recognize'))}</button>
      </div>
      <p class="muted small scan-hint">${esc(t('scan.hint'))}${canRecognize ? '' : ' ' + esc(t('scan.engineSoon'))}</p>
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

  private draw(): void {
    if (!this.straight) return;
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
