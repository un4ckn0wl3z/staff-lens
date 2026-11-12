# Exports oemer's scikit-learn SVM classifiers (clef, sfn, rests, rests_above8) for the browser.
# Run inside the oemer reference venv (see docs/PHASE2_PLAN.md), from any directory:
#   python tools/export_oemer_svm.py public/omr
# Writes oemer-svm.json (metadata + coefficients) and oemer-svm.bin.gz (support vectors as uint8).
import gzip, json, os, pickle, sys, warnings
import numpy as np
import oemer

warnings.filterwarnings('ignore')
out_dir = sys.argv[1]
os.makedirs(out_dir, exist_ok=True)
models = {}
blobs = []
offset = 0
for name in ['clef', 'sfn', 'rests', 'rests_above8']:
    info = pickle.load(open(os.path.join(oemer.MODULE_PATH, 'sklearn_models', f'{name}.model'), 'rb'))
    m = info['model']
    assert m.kernel == 'rbf', name
    sv = m.support_vectors_
    assert np.all(sv == np.round(sv)) and sv.min() >= 0 and sv.max() <= 255
    sv8 = sv.astype(np.uint8)
    blobs.append(sv8.tobytes())
    models[name] = {
        'w': int(info['w']), 'h': int(info['h']),
        'classMap': {str(k): v for k, v in info['class_map'].items()},
        'classes': [int(c) for c in m.classes_],
        'gamma': float(m._gamma),
        'nSupport': [int(n) for n in m._n_support],
        'dualCoef': m._dual_coef_.tolist(),   # libsvm sv_coef layout (n_class-1, n_SV)
        'intercept': m._intercept_.tolist(),  # libsvm -rho, one per class pair
        'features': int(sv.shape[1]),
        'svOffset': offset,
        'svCount': int(sv.shape[0]),
    }
    offset += sv8.size
json.dump({'source': 'oemer 0.1.8 sklearn_models (MIT)', 'models': models}, open(os.path.join(out_dir, 'oemer-svm.json'), 'w'))
with gzip.open(os.path.join(out_dir, 'oemer-svm.bin.gz'), 'wb', compresslevel=9) as f:
    f.write(b''.join(blobs))
print('exported', {k: v['svCount'] for k, v in models.items()}, offset, 'bytes')
