# Generates golden test cases for the TypeScript ports of the OpenCV / scipy primitives used by oemer.
# Run with the oemer reference venv (numpy<2, opencv-python-headless 4.9, scipy 1.13):
#   python tools/omr_golden.py tests/fixtures/omr/golden-primitives.json
import json, sys
import numpy as np, cv2
from scipy.signal import find_peaks
import scipy.ndimage

rng = np.random.default_rng(1234)
out = {}

def blobs(h, w, n, max_r=6, holes=True):
    img = np.zeros((h, w), np.uint8)
    for _ in range(n):
        x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
        kind = rng.integers(0, 3)
        if kind == 0:
            cv2.circle(img, (x, y), int(rng.integers(2, max_r)), 1, -1)
        elif kind == 1:
            cv2.rectangle(img, (x, y), (x + int(rng.integers(1, 12)), y + int(rng.integers(1, 12))), 1, -1)
        else:
            cv2.line(img, (x, y), (x + int(rng.integers(-20, 20)), y + int(rng.integers(-20, 20))), 1, int(rng.integers(1, 3)))
    if holes:
        for _ in range(n // 4):
            x, y = int(rng.integers(0, w)), int(rng.integers(0, h))
            cv2.circle(img, (x, y), int(rng.integers(1, 3)), 0, -1)
    return img

def enc(img):
    return {'w': int(img.shape[1]), 'h': int(img.shape[0]), 'data': ''.join(str(int(v)) for v in img.flatten())}

# find_peaks
peaks = []
for i in range(25):
    n = int(rng.integers(20, 120))
    x = rng.normal(0, 1, n)
    if i % 3 == 0:
        x = np.round(x * 2) / 2  # plateaus
    x = np.insert(x, [0, len(x)], [0, 0])
    height, distance, prominence = 0.8, int(rng.integers(1, 10)), float(rng.choice([0.5, 1.0]))
    if i % 3 == 0:
        distance = 1  # numpy's unstable argsort decides ties in the distance filter; keep plateau cases tie-free
    p, _ = find_peaks(x, height=height, distance=distance, prominence=prominence)
    peaks.append({'x': x.tolist(), 'height': height, 'distance': distance, 'prominence': prominence, 'peaks': p.tolist()})
out['find_peaks'] = peaks

# findContours (RETR_TREE) bounding boxes, in OpenCV order
contours = []
for i in range(12):
    img = blobs(int(rng.integers(20, 60)), int(rng.integers(20, 60)), int(rng.integers(3, 15)))
    cs, _ = cv2.findContours(img.copy(), cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    boxes = [list(cv2.boundingRect(c)) for c in cs]
    contours.append({'img': enc(img), 'boxes': boxes})
out['find_contours'] = contours

# erode / dilate with rectangular kernels (rows, cols)
morph = []
for i in range(12):
    img = blobs(int(rng.integers(15, 40)), int(rng.integers(15, 40)), int(rng.integers(3, 10)))
    kr, kc = int(rng.integers(1, 6)), int(rng.integers(1, 6))
    ker = np.ones((kr, kc), np.uint8)
    morph.append({'img': enc(img), 'rows': kr, 'cols': kc, 'erode': enc(cv2.erode(img, ker)), 'dilate': enc(cv2.dilate(img, ker))})
out['morph_rect'] = morph

# elliptical structuring elements
out['ellipse_kernels'] = [{'w': w, 'h': h, 'k': enc(cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (w, h)))}
                          for w, h in [(3, 3), (5, 5), (4, 6), (7, 3), (2, 2), (9, 9), (6, 11)]]

# scipy.ndimage.label (default 4-connectivity)
labels = []
for i in range(8):
    img = blobs(int(rng.integers(15, 40)), int(rng.integers(15, 40)), int(rng.integers(3, 12)))
    lab, n = scipy.ndimage.label(img)
    labels.append({'img': enc(img), 'n': int(n), 'labels': lab.flatten().tolist()})
out['label'] = labels

# HoughLinesP as used by oemer's find_lines (rho 1, theta 1°, threshold 50, minLineLength 10, maxLineGap 20)
hough = []
for i in range(8):
    h, w = int(rng.integers(60, 140)), int(rng.integers(60, 140))
    img = np.zeros((h, w), np.uint8)
    for _ in range(int(rng.integers(2, 6))):
        x1, y1 = int(rng.integers(0, w)), int(rng.integers(0, h))
        if rng.random() < 0.6:
            x2, y2 = x1 + int(rng.integers(-3, 4)), y1 + int(rng.integers(20, 80))  # near-vertical (barlines/stems)
        else:
            x2, y2 = x1 + int(rng.integers(-60, 60)), y1 + int(rng.integers(-60, 60))
        cv2.line(img, (x1, y1), (x2, y2), 1, int(rng.integers(1, 4)))
    noise = blobs(h, w, int(rng.integers(0, 6)), holes=False)
    img = np.maximum(img, noise)
    lines = cv2.HoughLinesP(img, 1, np.pi / 180, 50, None, 10, 20)
    hough.append({'img': enc(img), 'lines': [] if lines is None else [list(map(int, l[0])) for l in lines]})
out['hough_lines_p'] = hough

# sklearn AgglomerativeClustering(distance_threshold=..., ward) labels, as used by oemer's merge_nearby_bbox
from sklearn.cluster import AgglomerativeClustering
agg = []
for i in range(15):
    n = int(rng.integers(2, 30))
    pts = rng.integers(0, 400, (n, 2)).astype(float) / 2  # half-pixel centres like bbox centres
    if i % 2 == 0:
        pts[:, 1] *= 5  # y_factor
    th = float(rng.choice([15.0, 40.0, 60.0]))
    m = AgglomerativeClustering(n_clusters=None, distance_threshold=th, compute_full_tree=True).fit(pts)
    agg.append({'points': pts.tolist(), 'threshold': th, 'labels': m.labels_.tolist()})
out['agglomerative'] = agg

# CPython set(...) then discard(0) then pop()
pops = []
for i in range(40):
    k = int(rng.integers(1, 12))
    vals = sorted(set(int(v) for v in rng.integers(0, 60, k)))
    if i % 3 == 0:
        vals = sorted(set([0] + vals))
    s2 = set(np.unique(np.array(vals)))
    if 0 in s2:
        s2.remove(0)
    pops.append({'vals': vals, 'pop': int(s2.pop()) if s2 else None})
out['set_pop'] = pops

# numpy float sums (pairwise)
sums = []
for n in [3, 8, 9, 17, 100, 129, 300, 1000]:
    x = rng.normal(0, 1e3, n)
    sums.append({'x': x.tolist(), 'sum': float(np.sum(x)), 'mean': float(np.mean(x))})
out['np_sum'] = sums

json.dump(out, open(sys.argv[1], 'w'))
print('golden cases written')
