// Faithful re-implementations of library behaviour oemer depends on implicitly:
// numpy's pairwise sum, CPython's set.pop() order, Python's heapq, scipy's Ward linkage and
// sklearn's AgglomerativeClustering(distance_threshold=…) labelling.

/** numpy's pairwise summation for float64 (used by np.sum / np.mean). */
export function npSum(a: ArrayLike<number>, start = 0, n = a.length - start): number {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[start + i];
    return res;
  }
  if (n <= 128) {
    const r = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let j = 0; j < 8; j++) r[j] = a[start + j];
    let i = 8;
    for (; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[start + i + j];
    let res = r[0] + r[1] + (r[2] + r[3]) + (r[4] + r[5] + (r[6] + r[7]));
    for (; i < n; i++) res += a[start + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return npSum(a, start, n2) + npSum(a, start + n2, n - n2);
}

export const npMean = (a: ArrayLike<number>): number => npSum(a) / a.length;

/**
 * Result of `s = set(sorted_ints); s.discard(0); s.pop()` in CPython 3.11 for small non-negative ints
 * (hash(i) == i). Returns undefined for an empty set.
 */
export function cpythonSetPop(sortedInts: number[], remove0 = true): number | undefined {
  const PERTURB_SHIFT = 5;
  const LINEAR_PROBES = 9;
  const DUMMY = -1;
  let size = 8;
  let table: (number | null)[] = new Array(size).fill(null);
  let fill = 0;
  let used = 0;
  const insert = (tab: (number | null)[], key: number): void => {
    const mask = tab.length - 1;
    let perturb = key;
    let i = key & mask;
    for (;;) {
      let probes = i + LINEAR_PROBES <= mask ? LINEAR_PROBES : 0;
      let j = i;
      do {
        if (tab[j] === null) {
          tab[j] = key;
          return;
        }
        j++;
      } while (probes-- > 0);
      perturb = Math.floor(perturb / 2 ** PERTURB_SHIFT);
      i = (i * 5 + 1 + perturb) & mask;
    }
  };
  for (const k of sortedInts) {
    if (table.includes(k)) continue;
    insert(table, k);
    fill++;
    used++;
    if (fill * 5 >= (size - 1) * 3) {
      const minused = used > 50000 ? used * 2 : used * 4;
      let newsize = 8;
      while (newsize <= minused) newsize <<= 1;
      const old = table;
      table = new Array(newsize).fill(null);
      size = newsize;
      for (const e of old) if (e !== null && e !== DUMMY) insert(table, e);
      fill = used;
    }
  }
  if (remove0) {
    const z = table.indexOf(0);
    if (z >= 0) {
      table[z] = DUMMY;
      used--;
    }
  }
  if (used === 0) return undefined;
  for (const e of table) if (e !== null && e !== DUMMY) return e;
  return undefined;
}

// ------------------------------------------------------------------ heapq

type Cmp<T> = (a: T, b: T) => boolean; // a < b

function siftDown<T>(heap: T[], start: number, pos: number, lt: Cmp<T>): void {
  const item = heap[pos];
  while (pos > start) {
    const pp = (pos - 1) >> 1;
    const parent = heap[pp];
    if (lt(item, parent)) {
      heap[pos] = parent;
      pos = pp;
      continue;
    }
    break;
  }
  heap[pos] = item;
}

function siftUp<T>(heap: T[], pos: number, lt: Cmp<T>): void {
  const end = heap.length;
  const start = pos;
  const item = heap[pos];
  let child = 2 * pos + 1;
  while (child < end) {
    const right = child + 1;
    if (right < end && !lt(heap[child], heap[right])) child = right;
    heap[pos] = heap[child];
    pos = child;
    child = 2 * pos + 1;
  }
  heap[pos] = item;
  siftDown(heap, start, pos, lt);
}

export function heappush<T>(heap: T[], item: T, lt: Cmp<T>): void {
  heap.push(item);
  siftDown(heap, 0, heap.length - 1, lt);
}

export function heappushpop<T>(heap: T[], item: T, lt: Cmp<T>): T {
  if (heap.length && lt(heap[0], item)) {
    const top = heap[0];
    heap[0] = item;
    siftUp(heap, 0, lt);
    return top;
  }
  return item;
}

// ------------------------------------------------------------------ Ward clustering

/** scipy.cluster.hierarchy.ward(X) via the NN-chain algorithm; returns Z rows [a, b, dist, size]. */
export function wardLinkage(points: [number, number][]): number[][] {
  const n = points.length;
  const ci = (i: number, j: number) => {
    if (i > j) [i, j] = [j, i];
    return n * i - (i * (i + 1)) / 2 + (j - i - 1);
  };
  const D = new Float64Array((n * (n - 1)) / 2);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[ci(i, j)] = Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]);
  const size = new Int32Array(n).fill(1);
  const chain: number[] = [];
  const Z: number[][] = [];
  for (let k = 0; k < n - 1; k++) {
    if (chain.length === 0) {
      for (let i = 0; i < n; i++)
        if (size[i] > 0) {
          chain.push(i);
          break;
        }
    }
    let x = 0;
    let y = 0;
    let currentMin = Infinity;
    for (;;) {
      x = chain[chain.length - 1];
      if (chain.length > 1) {
        y = chain[chain.length - 2];
        currentMin = D[ci(x, y)];
      } else currentMin = Infinity;
      for (let i = 0; i < n; i++) {
        if (size[i] === 0 || x === i) continue;
        const d = D[ci(x, i)];
        if (d < currentMin) {
          currentMin = d;
          y = i;
        }
      }
      if (chain.length > 1 && y === chain[chain.length - 2]) break;
      chain.push(y);
    }
    chain.length -= 2;
    if (x > y) [x, y] = [y, x];
    const nx = size[x];
    const ny = size[y];
    Z.push([x, y, currentMin, nx + ny]);
    size[x] = 0;
    size[y] = nx + ny;
    for (let i = 0; i < n; i++) {
      const ni = size[i];
      if (ni === 0 || i === y) continue;
      const dxi = D[ci(i, x)];
      const dyi = D[ci(i, y)];
      const t = 1 / (nx + ny + ni);
      D[ci(i, y)] = Math.sqrt((ni + nx) * t * dxi * dxi + (ni + ny) * t * dyi * dyi - ni * t * currentMin * currentMin);
    }
  }
  // stable sort by distance, then relabel (scipy `label`)
  const order = Z.map((_, i) => i).sort((a, b) => Z[a][2] - Z[b][2] || a - b);
  const sorted = order.map((i) => [...Z[i]]);
  const parent = Array.from({ length: 2 * n - 1 }, (_, i) => i);
  const find = (a: number) => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const nx2 = parent[a];
      parent[a] = r;
      a = nx2;
    }
    return r;
  };
  let next = n;
  for (const row of sorted) {
    const xr = find(row[0]);
    const yr = find(row[1]);
    [row[0], row[1]] = xr < yr ? [xr, yr] : [yr, xr];
    parent[xr] = next;
    parent[yr] = next;
    next++;
  }
  return sorted;
}

/** sklearn AgglomerativeClustering(n_clusters=None, distance_threshold=d, linkage='ward').labels_ */
export function wardClusterLabels(points: [number, number][], distanceThreshold: number): number[] {
  const n = points.length;
  if (n < 2) return n === 1 ? [0] : [];
  const Z = wardLinkage(points);
  const children = Z.map((r) => [r[0], r[1]]);
  const nClusters = Z.filter((r) => r[2] >= distanceThreshold).length + 1;
  // _hc_cut with a max-heap stored as negative values
  const lt = (a: number, b: number) => a < b;
  const nodes: number[] = [-(Math.max(...children[children.length - 1]) + 1)];
  for (let c = 0; c < nClusters - 1; c++) {
    const these = children[-nodes[0] - n];
    heappush(nodes, -these[0], lt);
    heappushpop(nodes, -these[1], lt);
  }
  const labels = new Array<number>(n).fill(0);
  nodes.forEach((node, i) => {
    const stack = [-node];
    while (stack.length) {
      const v = stack.pop()!;
      if (v < n) labels[v] = i;
      else stack.push(...children[v - n]);
    }
  });
  return labels;
}
