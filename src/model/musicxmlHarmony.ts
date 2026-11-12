// Reads chord symbols (<harmony>) straight from MusicXML so slash chords (<bass>) and offsets survive.
// alphaTab also reads <harmony>, but drops the bass note; this parser is used for uncompressed MusicXML.

export interface ParsedHarmony {
  measure: number;
  /** Tick within the measure (960 per quarter). */
  tick: number;
  text: string;
}

const KIND_SUFFIX: Record<string, string> = {
  major: '',
  minor: 'm',
  augmented: 'aug',
  diminished: 'dim',
  dominant: '7',
  'major-seventh': 'maj7',
  'minor-seventh': 'm7',
  'diminished-seventh': 'dim7',
  'half-diminished': 'm7b5',
  'major-minor': 'm(maj7)',
  'major-sixth': '6',
  'minor-sixth': 'm6',
  'dominant-ninth': '9',
  'major-ninth': 'maj9',
  'minor-ninth': 'm9',
  'suspended-second': 'sus2',
  'suspended-fourth': 'sus4',
  power: '5',
};

const ALTER: Record<string, string> = { '-2': 'bb', '-1': 'b', '0': '', '1': '#', '2': '##' };

function child(el: Element, name: string): Element | null {
  for (const c of Array.from(el.children)) if (c.localName === name) return c;
  return null;
}

function text(el: Element | null): string {
  return el?.textContent?.trim() ?? '';
}

function harmonyText(h: Element): string | null {
  const root = child(h, 'root');
  const kindEl = child(h, 'kind');
  const kind = text(kindEl);
  if (!root || kind === 'none') return null;
  const rootName = text(child(root, 'root-step')) + (ALTER[text(child(root, 'root-alter')) || '0'] ?? '');
  let suffix = KIND_SUFFIX[kind];
  if (suffix === undefined) {
    const attr = kindEl?.getAttribute('text');
    suffix = attr ?? '';
  }
  // add9 / added degrees on simple triads
  for (const d of Array.from(h.children).filter((c) => c.localName === 'degree')) {
    const value = text(child(d, 'degree-value'));
    const type = text(child(d, 'degree-type'));
    if (type === 'add' && (suffix === '' || suffix === 'm')) suffix += `add${value}`;
  }
  const bass = child(h, 'bass');
  const bassName = bass ? '/' + text(child(bass, 'bass-step')) + (ALTER[text(child(bass, 'bass-alter')) || '0'] ?? '') : '';
  return rootName + suffix + bassName;
}

/** Returns harmonies per part (outer index = part order = alphaTab track index). */
export function parseMusicXmlHarmony(xml: string): ParsedHarmony[][] | null {
  if (typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) return null;
  const parts = Array.from(doc.getElementsByTagName('part'));
  if (parts.length === 0) return null; // score-timewise or invalid
  let any = false;
  const result = parts.map((part) => {
    const out: ParsedHarmony[] = [];
    let divisions = 1;
    Array.from(part.children)
      .filter((c) => c.localName === 'measure')
      .forEach((measure, mi) => {
        let pos = 0;
        for (const c of Array.from(measure.children)) {
          switch (c.localName) {
            case 'attributes': {
              const d = Number(text(child(c, 'divisions')));
              if (d > 0) divisions = d;
              break;
            }
            case 'note': {
              const isChord = !!child(c, 'chord');
              const isGrace = !!child(c, 'grace');
              const dur = Number(text(child(c, 'duration'))) || 0;
              if (isChord) break;
              if (!isGrace) pos += dur;
              break;
            }
            case 'backup':
              pos -= Number(text(child(c, 'duration'))) || 0;
              break;
            case 'forward':
              pos += Number(text(child(c, 'duration'))) || 0;
              break;
            case 'harmony': {
              const t = harmonyText(c);
              if (!t) break;
              const offset = Number(text(child(c, 'offset'))) || 0;
              const at = Math.max(0, pos + offset);
              out.push({ measure: mi, tick: Math.round((at / divisions) * 960), text: t });
              any = true;
              break;
            }
          }
        }
      });
    return out;
  });
  return any ? result : null;
}
