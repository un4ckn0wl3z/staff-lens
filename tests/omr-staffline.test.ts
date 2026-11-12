// Compares the TypeScript port of oemer's staff-line extraction with oemer's own output
// (tests/fixtures/omr/reference.json, produced by tools/oemer_reference.py on aura-lee-staff.png).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { mapsFromPacked, OemerContext } from '../src/omr/oemer/context';
import { extractStaffs } from '../src/omr/oemer/staffline';

const dir = join(__dirname, 'fixtures', 'omr');
const ref = JSON.parse(readFileSync(join(dir, 'reference.json'), 'utf8'));

export function loadContext(): OemerContext {
  const packed = new Uint8Array(gunzipSync(readFileSync(join(dir, 'maps.u8.gz'))));
  return new OemerContext(mapsFromPacked(ref.width, ref.height, packed));
}

const LABELS = ['FIRST', 'SECOND', 'THIRD', 'FOURTH', 'FIFTH'];

describe('oemer staff-line extraction port', () => {
  const ctx = loadContext();
  const res = extractStaffs(ctx);

  it('finds the same zones', () => {
    expect(res.zones.map((z) => [z.start, z.stop])).toEqual(ref.zones);
  });

  it('finds the same staves with the same geometry', () => {
    expect([res.staffs.length, res.staffs[0].length]).toEqual(ref.staffs_shape);
    res.staffs.forEach((col, z) =>
      col.forEach((st, r) => {
        const e = ref.staffs[z][r];
        const where = `zone ${z} row ${r}`;
        expect(st.track, where).toBe(e.track);
        expect(st.group, where).toBe(e.group);
        expect(st.isInterp, where).toBe(e.is_interp);
        expect(st.yCenter, where).toBeCloseTo(e.y_center, 6);
        expect(st.yUpper, where).toBe(e.y_upper);
        expect(st.yLower, where).toBe(e.y_lower);
        expect(st.xLeft, where).toBe(e.x_left);
        expect(st.xRight, where).toBe(e.x_right);
        expect(st.unitSize, where).toBeCloseTo(e.unit_size, 6);
        expect(st.slope, where).toBeCloseTo(e.slope, 8);
        st.lines.forEach((l, k) => {
          expect(LABELS[l.label!], `${where} line ${k}`).toBe(e.lines[k].label);
          expect(l.size, `${where} line ${k}`).toBe(e.lines[k].points);
        });
      }),
    );
  });
});
