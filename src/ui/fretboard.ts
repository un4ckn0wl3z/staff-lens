// Interactive fretboard strip under the score.

import type { FretPosition } from '../theory/fretboard';
import { boardSvg, fretX, geometry, noteNameOf, stringY } from './svg';

export interface FretHighlight extends FretPosition {
  kind: 'current' | 'option' | 'playing' | 'picked';
}

export class Fretboard {
  private tuning: number[] = [64, 59, 55, 50, 45, 40];
  private capo = 0;
  private frets = 15;
  private highlights: FretHighlight[] = [];
  private svg: SVGSVGElement;

  constructor(
    host: HTMLElement,
    private onPick: (pos: FretPosition, midi: number) => void,
  ) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('fretboard');
    this.svg.setAttribute('role', 'group');
    host.appendChild(this.svg);
    this.svg.addEventListener('click', (e) => {
      const target = (e.target as Element).closest('[data-string]') as SVGElement | null;
      if (!target) return;
      const string = Number(target.dataset.string);
      const fret = Number(target.dataset.fret);
      this.onPick({ string, fret }, this.tuning[string - 1] + fret);
    });
    this.svg.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = (e.target as Element).closest('[data-string]') as SVGElement | null;
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    this.render();
  }

  configure(tuning: number[], capo: number, frets = 15): void {
    this.tuning = tuning;
    this.capo = capo;
    this.frets = frets;
    this.render();
  }

  setHighlights(h: FretHighlight[]): void {
    this.highlights = h;
    this.renderDots();
  }

  private render(): void {
    const g = geometry(this.frets, this.tuning.length);
    this.svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
    const cells: string[] = [];
    for (let s = 1; s <= this.tuning.length; s++) {
      for (let f = 0; f <= this.frets; f++) {
        const x = f === 0 ? g.left - 30 : g.left + (f - 1) * g.fretW;
        const w = f === 0 ? 28 : g.fretW;
        const y = stringY(g, s) - g.stringGap / 2;
        const name = noteNameOf(this.tuning[s - 1] + f);
        cells.push(
          `<rect class="fb-cell" x="${x}" y="${y}" width="${w}" height="${g.stringGap}" data-string="${s}" data-fret="${f}" tabindex="-1" role="button" aria-label="${name}"><title>${name}</title></rect>`,
        );
      }
    }
    this.svg.innerHTML = `${boardSvg(g, this.tuning, this.capo)}<g class="fb-cells">${cells.join('')}</g><g class="fb-dots"></g>`;
    // make the first cell of each string keyboard reachable
    this.svg.querySelectorAll<SVGElement>('.fb-cell[data-fret="0"]').forEach((c) => c.setAttribute('tabindex', '0'));
    this.renderDots();
  }

  private renderDots(): void {
    const g = geometry(this.frets, this.tuning.length);
    const layer = this.svg.querySelector('.fb-dots');
    if (!layer) return;
    layer.innerHTML = this.highlights
      .filter((h) => h.fret <= this.frets)
      .map((h) => {
        const x = fretX(g, h.fret);
        const y = stringY(g, h.string);
        const label = h.kind === 'current' || h.kind === 'playing' || h.kind === 'picked' ? noteNameOf(this.tuning[h.string - 1] + h.fret).replace(/-?\d+$/, '') : '';
        return `<g class="fb-mark ${h.kind}"><circle cx="${x}" cy="${y}" r="8"/>${label ? `<text x="${x}" y="${y + 3.5}">${label}</text>` : ''}</g>`;
      })
      .join('');
  }
}
