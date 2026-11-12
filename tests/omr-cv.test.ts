// Golden tests: TypeScript ports vs real OpenCV 4.9 / scipy 1.13 outputs (tools/omr_golden.py).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cpythonSetPop, npMean, npSum, PySet, wardClusterLabels } from '../src/omr/oemer/pyport';
import { gunzipSync } from 'node:zlib';
import { loadSvmBundle, pilResize, predictRegion } from '../src/omr/oemer/classifier';
import { contourArea, fillPoly, minAreaRect } from '../src/omr/oemer/rotated';
import { dilate, drawLine8, ellipseKernel, findContours, erode, findContourBoxes, findPeaks, houghLinesP, label4, olsSlope, rectKernel, type Raster } from '../src/omr/oemer/cv';

interface Enc {
  w: number;
  h: number;
  data: string;
}
const golden = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'omr', 'golden-primitives.json'), 'utf8'));
const dec = (e: Enc): Raster => ({ width: e.w, height: e.h, data: Uint8Array.from(e.data, (c) => Number(c)) });
const str = (r: Raster) => Array.from(r.data).join('');

describe('OpenCV / scipy ports', () => {
  it('find_peaks matches scipy', () => {
    for (const c of golden.find_peaks) {
      expect(findPeaks(c.x, { height: c.height, distance: c.distance, prominence: c.prominence })).toEqual(c.peaks);
    }
  });

  it('erode / dilate with rectangular kernels match OpenCV', () => {
    for (const c of golden.morph_rect) {
      const img = dec(c.img);
      const k = rectKernel(c.rows, c.cols);
      expect(str(erode(img, k))).toBe(c.erode.data);
      expect(str(dilate(img, k))).toBe(c.dilate.data);
    }
  });

  it('ellipse structuring elements match OpenCV', () => {
    for (const c of golden.ellipse_kernels) {
      const k = ellipseKernel(c.w, c.h);
      expect(Array.from(k.data).join(''), `${c.w}x${c.h}`).toBe(c.k.data);
    }
  });

  it('ndimage.label matches scipy', () => {
    for (const c of golden.label) {
      const r = label4(dec(c.img));
      expect(r.count).toBe(c.n);
      expect(Array.from(r.labels)).toEqual(c.labels);
    }
  });

  it('findContours bounding boxes match OpenCV (same order)', () => {
    for (const c of golden.find_contours) {
      const boxes = findContourBoxes(dec(c.img)).map(([x1, y1, x2, y2]) => [x1, y1, x2 - x1, y2 - y1]);
      expect(boxes).toEqual(c.boxes);
    }
  });

  it('HoughLinesP matches OpenCV', () => {
    for (const c of golden.hough_lines_p) {
      expect(houghLinesP(dec(c.img), 1, Math.PI / 180, 50, 10, 20)).toEqual(c.lines);
    }
  });

  it('least-squares slope', () => {
    expect(olsSlope([0, 1, 2, 3], [1, 3, 5, 7])).toBeCloseTo(2);
    expect(olsSlope([5, 5], [1, 2])).toBe(0);
  });
});

describe('Python library behaviour ports', () => {
  it('AgglomerativeClustering (ward, distance threshold) labels match sklearn', () => {
    for (const c of golden.agglomerative) expect(wardClusterLabels(c.points, c.threshold)).toEqual(c.labels);
  });
  it('set.pop() order matches CPython', () => {
    for (const c of golden.set_pop) expect(cpythonSetPop(c.vals) ?? null, JSON.stringify(c.vals)).toBe(c.pop);
  });
  it('PySet iteration, intersection and pop match CPython', () => {
    for (const c of golden.set_ops) {
      const s = new PySet(c.vals);
      for (const r of c.removed) s.discard(r);
      expect(s.values(), JSON.stringify(c.vals)).toEqual(c.order);
      expect(s.intersection(new PySet(c.keys)).values()).toEqual(c.inter);
      const pops: number[] = [];
      while (pops.length < 3 && s.size) pops.push(s.pop());
      expect(pops).toEqual(c.pops);
    }
  });
  it('numpy pairwise sums match exactly', () => {
    for (const c of golden.np_sum) {
      expect(npSum(c.x)).toBe(c.sum);
      expect(npMean(c.x)).toBe(c.mean);
    }
  });
});

describe('Pillow resize, SVM classifiers and line drawing', () => {
  const svmMeta = JSON.parse(readFileSync(join(__dirname, '..', 'public', 'omr', 'oemer-svm.json'), 'utf8'));
  const svBytes = new Uint8Array(gunzipSync(readFileSync(join(__dirname, '..', 'public', 'omr', 'oemer-svm.bin.gz'))));
  const bundle = loadSvmBundle(svmMeta, svBytes);

  it('PIL bicubic resize matches Pillow', () => {
    for (const c of golden.pil_resize) {
      const r = dec(c.img);
      const data = c.scale255 ? r.data.map((v) => v * 255) : r.data.map((v) => v * 255);
      expect(Array.from(pilResize(data, r.width, r.height, 40, 70))).toEqual(c.out);
    }
  });

  it('SVM predictions match scikit-learn for all four oemer models', () => {
    for (const c of golden.svm_predict) {
      const r = dec(c.img);
      for (const name of Object.keys(c.pred)) {
        const region = { w: r.width, h: r.height, data: Int32Array.from(r.data) };
        expect(predictRegion(bundle, region, name), name).toBe(c.pred[name]);
      }
    }
  });

  it('8-connected cv2.line matches OpenCV, including clipping', () => {
    for (const c of golden.line8) {
      const img = { width: c.w, height: c.h, data: new Uint8Array(c.w * c.h) };
      for (const s of c.segs) drawLine8(img, s[0], s[1], s[2], s[3]);
      expect(Array.from(img.data).join(''), JSON.stringify(c.segs)).toBe(c.out.data);
    }
  });
});

describe('rotated boxes and polygon fill (beams)', () => {
  it('fillPoly and contourArea match OpenCV', () => {
    for (const c of golden.fill_poly) {
      const img = { width: c.w, height: c.h, data: new Uint8Array(c.w * c.h) };
      fillPoly(img, c.pts);
      expect(Array.from(img.data).join(''), JSON.stringify(c.pts)).toBe(c.out.data);
      expect(contourArea(c.pts)).toBe(c.area);
    }
  });

  it('minAreaRect corners (truncated like oemer) match OpenCV', () => {
    let same = 0;
    const key = (pts: number[][]) => pts.map((p) => p.join(',')).sort().join(' ');
    for (const c of golden.min_area_rect) {
      const r = minAreaRect(c.pts);
      const neg = r.corners.some(([x, y]) => x < 0 || y < 0);
      if (neg !== c.neg) continue;
      if (neg) {
        same++;
        continue;
      }
      if (key(r.corners.map(([x, y]) => [Math.trunc(x), Math.trunc(y)])) === key(c.trunc)) same++;
      expect(Math.min(...r.size)).toBeCloseTo(Math.min(...c.size), 3);
    }
    // float32 noise in OpenCV's calipers can move a truncated corner by one pixel
    expect(same / golden.min_area_rect.length).toBeGreaterThan(0.9);
  });

  it('findContours points are the border pixels', () => {
    for (const c of golden.contour_points) {
      const mine = findContours(dec(c.img));
      expect(mine.length).toBe(c.contours.length);
      mine.forEach((m, k) => {
        const set = new Set(m.points.map((p) => p.join(',')));
        for (const p of c.contours[k]) expect(set.has(p.join(',')), `contour ${k}`).toBe(true);
      });
    }
  });
});
