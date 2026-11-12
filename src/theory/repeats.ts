// Play-order map: expands repeats, volta brackets (1st/2nd endings), D.C., D.S., Coda and Fine
// into the list of bars in the order they are actually played.

export type JumpMarker = 'daCapo' | 'daCapoAlFine' | 'daCapoAlCoda' | 'dalSegno' | 'dalSegnoAlFine' | 'dalSegnoAlCoda' | 'toCoda';
export type TargetMarker = 'segno' | 'coda' | 'fine';

export interface RepeatBar {
  repeatStart?: boolean;
  /** Total number of times the repeated section is played (2 = play twice). 0/undefined = no repeat sign. */
  repeatEnd?: number;
  /** Volta numbers this bar belongs to, e.g. [1] or [1, 2]. */
  endings?: number[];
  /** Jump instructions at the end of this bar. */
  jumps?: JumpMarker[];
  /** Signs placed on this bar (segno / coda at its start, fine at its end). */
  targets?: TargetMarker[];
}

/** Returns 0-based bar indexes in playback order. Repeats are not taken again after a D.C./D.S. jump (common convention). */
export function playOrder(bars: RepeatBar[], maxLength = 10000): number[] {
  const order: number[] = [];
  const segno = bars.findIndex((b) => b.targets?.includes('segno'));
  const coda = bars.findIndex((b) => b.targets?.includes('coda'));
  const groupMax = endingGroupMax(bars);
  let i = 0;
  let sectionStart = 0;
  let pass = 1;
  let returningTo = -1;
  let jumped: null | 'fine' | 'coda' | 'plain' = null;
  const usedJumps = new Set<number>();

  while (i < bars.length && order.length < maxLength) {
    const b = bars[i];
    if (b.repeatStart) {
      if (returningTo !== i) {
        sectionStart = i;
        pass = 1;
      }
      returningTo = -1;
    }
    if (b.endings && b.endings.length > 0) {
      const play = jumped ? b.endings.includes(groupMax[i]) : b.endings.includes(pass);
      if (!play) {
        i++;
        continue;
      }
    }
    order.push(i);

    if (jumped === 'fine' && b.targets?.includes('fine')) break;
    if (jumped === 'coda' && b.jumps?.includes('toCoda') && coda > i) {
      i = coda;
      continue;
    }
    if (!jumped && b.repeatEnd && b.repeatEnd > 1) {
      if (pass < b.repeatEnd) {
        pass++;
        returningTo = sectionStart;
        i = sectionStart;
        continue;
      }
      pass = 1;
      sectionStart = i + 1;
    } else if (!jumped && b.endings?.includes(groupMax[i]) && (i + 1 >= bars.length || !bars[i + 1].endings?.length)) {
      // Left the last volta: the next repeat section starts fresh.
      pass = 1;
      sectionStart = i + 1;
    }

    const jump = b.jumps?.find((j) => j !== 'toCoda');
    if (jump && !jumped && !usedJumps.has(i)) {
      usedJumps.add(i);
      jumped = jump.endsWith('AlFine') ? 'fine' : jump.endsWith('AlCoda') ? 'coda' : 'plain';
      i = jump.startsWith('daCapo') ? 0 : Math.max(0, segno);
      pass = 1;
      sectionStart = i;
      continue;
    }
    i++;
  }
  return order;
}

/** For bars inside a run of volta brackets, the highest ending number in that run. */
function endingGroupMax(bars: RepeatBar[]): number[] {
  const out = new Array<number>(bars.length).fill(0);
  let i = 0;
  while (i < bars.length) {
    if (!bars[i].endings?.length) {
      i++;
      continue;
    }
    let j = i;
    let max = 0;
    while (j < bars.length && bars[j].endings?.length) {
      max = Math.max(max, ...bars[j].endings!);
      j++;
    }
    for (let k = i; k < j; k++) out[k] = max;
    i = j;
  }
  return out;
}

/** Compresses a play order into ranges for display, e.g. [0,1,2,3,0,1] -> "1–4, 1–2" (1-based). */
export function formatPlayOrder(order: number[]): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 1; i <= order.length; i++) {
    if (i === order.length || order[i] !== order[i - 1] + 1) {
      const a = order[start] + 1;
      const b = order[i - 1] + 1;
      parts.push(a === b ? `${a}` : `${a}–${b}`);
      start = i;
    }
  }
  return parts.join(', ');
}
