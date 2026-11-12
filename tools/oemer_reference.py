# Runs oemer 0.1.8 step by step and dumps model maps + every intermediate result for the TS port tests.
import sys, os, json, gzip, enum, time
import numpy as np, cv2
from oemer import layers, MODULE_PATH
from oemer import ete
from oemer.staffline_extraction import extract as staff_extract
from oemer.notehead_extraction import extract as note_extract
from oemer.note_group_extraction import extract as group_extract
from oemer.symbol_extraction import extract as symbol_extract
from oemer.rhythm_extraction import extract as rhythm_extract
from oemer.build_system import MusicXMLBuilder

img_path, out_dir = sys.argv[1], sys.argv[2]
os.makedirs(out_dir, exist_ok=True)
maps_path = os.path.join(out_dir, 'maps.npz')

def conv(o, depth=0):
    if depth > 4: return None
    if isinstance(o, enum.Enum): return o.name
    if isinstance(o, (np.integer,)): return int(o)
    if isinstance(o, (np.floating,)): return float(o)
    if isinstance(o, np.ndarray):
        return o.tolist() if o.size <= 64 else {'shape': list(o.shape)}
    if isinstance(o, (list, tuple)): return [conv(x, depth+1) for x in o]
    if isinstance(o, dict): return {str(k): conv(v, depth+1) for k, v in o.items()}
    if isinstance(o, (int, float, str, bool)) or o is None: return o
    if isinstance(o, range): return [o.start, o.stop]
    if hasattr(o, '__dict__'):
        return {k.lstrip('_'): (len(v) if k == 'points' else conv(v, depth+1)) for k, v in vars(o).items() if not k.startswith('__')}
    return str(o)

t0 = time.time()
if os.path.exists(maps_path):
    d = np.load(maps_path)
    staff, symbols, stems_rests, notehead, clefs_keys = [d[k] for k in ['staff', 'symbols', 'stems_rests', 'notehead', 'clefs_keys']]
else:
    staff, symbols, stems_rests, notehead, clefs_keys = ete.generate_pred(img_path)
    np.savez_compressed(maps_path, staff=staff, symbols=symbols, stems_rests=stems_rests, notehead=notehead, clefs_keys=clefs_keys)
print('pred', round(time.time() - t0, 1), 's', staff.shape, flush=True)

# packed maps for the TS tests: bit0 staff, bit1 symbols, bit2 stems/rests, bit3 noteheads, bit4 clefs/keys
h, w = staff.shape
packed = (staff.astype(np.uint8) | (symbols.astype(np.uint8) << 1) | (stems_rests.astype(np.uint8) << 2)
          | (notehead.astype(np.uint8) << 3) | (clefs_keys.astype(np.uint8) << 4))
with gzip.open(os.path.join(out_dir, 'maps.u8.gz'), 'wb') as f: f.write(packed.tobytes())

image = cv2.imread(img_path)
image = cv2.resize(image, (w, h))
cv2.imwrite(os.path.join(out_dir, 'resized.png'), image)

ete.clear_data()
symbols = symbols + clefs_keys + stems_rests
symbols[symbols > 1] = 1
layers.register_layer("stems_rests_pred", stems_rests)
layers.register_layer("clefs_keys_pred", clefs_keys)
layers.register_layer("notehead_pred", notehead)
layers.register_layer("symbols_pred", symbols)
layers.register_layer("staff_pred", staff)
layers.register_layer("original_image", image)

out = {'width': int(w), 'height': int(h)}
staffs, zones = staff_extract()
layers.register_layer("staffs", staffs); layers.register_layer("zones", zones)
def line_sum(l):
    return {'y_center': float(l.y_center), 'y_upper': float(l.y_upper), 'y_lower': float(l.y_lower), 'x_left': float(l.x_left),
            'x_right': float(l.x_right), 'label': l.label.name if l.label is not None else None, 'points': len(l.points), 'slope': float(l.slope)}
def staff_sum(st):
    return {'y_center': float(st.y_center), 'y_upper': float(st.y_upper), 'y_lower': float(st.y_lower), 'x_left': float(st.x_left),
            'x_right': float(st.x_right), 'x_center': float(st.x_center), 'unit_size': float(st.unit_size), 'slope': float(st.slope),
            'track': st.track, 'group': st.group, 'is_interp': bool(st.is_interp), 'lines': [line_sum(l) for l in st.lines]}
out['staffs'] = [[staff_sum(s) for s in col] for col in staffs]
out['staffs_shape'] = list(staffs.shape)
out['zones'] = conv(list(zones))
print('staffs', staffs.shape, flush=True)

notes = note_extract()
layers.register_layer('notes', np.array(notes))
layers.register_layer('note_id', np.zeros(symbols.shape, dtype=np.int64) - 1)
ete.register_note_id()
out['notes_after_extract'] = conv(notes)
print('notes', len(notes), flush=True)

groups, group_map = group_extract()
layers.register_layer('note_groups', np.array(groups)); layers.register_layer('group_map', group_map)
out['groups'] = conv(groups)
print('groups', len(groups), flush=True)

barlines, clefs, sfns, rests = symbol_extract()
for n, v in [('barlines', barlines), ('clefs', clefs), ('sfns', sfns), ('rests', rests)]:
    layers.register_layer(n, np.array(v)); out[n] = conv(v)
print('symbols', len(barlines), len(clefs), len(sfns), len(rests), flush=True)

rhythm_extract()
out['notes'] = conv(list(layers.get_layer('notes')))
out['groups_after_rhythm'] = conv(list(layers.get_layer('note_groups')))
out['rests_after_rhythm'] = conv(list(layers.get_layer('rests')))

builder = MusicXMLBuilder(title='Aura Lee')
builder.build()
xml = builder.to_musicxml()
open(os.path.join(out_dir, 'oemer.musicxml'), 'wb').write(xml)
json.dump(out, open(os.path.join(out_dir, 'reference.json'), 'w'), indent=1)
print('done', round(time.time() - t0, 1), 's', flush=True)
