# Makes a synthetic "phone photo" of a rendered test page: the page on paper, tilted in perspective on a dark table,
# with uneven light, a little blur, sensor noise and JPEG compression. Writes the photo (JPEG), the paper corners and
# the page rectified with OpenCV (the input oemer gets in the reference run).
# Run: python tools/make_photo_fixture.py tests/fixtures/omr/rhythm-study.png tests/fixtures/omr/rhythm-photo <rectified.png>
import sys, os, json
import numpy as np, cv2

src_path, out_dir, rectified_path = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out_dir, exist_ok=True)
rng = np.random.default_rng(7)

page = cv2.imread(src_path)
m = 60
paper = cv2.copyMakeBorder(page, m, m, m, m, cv2.BORDER_CONSTANT, value=(255, 255, 255))
ph, pw = paper.shape[:2]
paper = (paper.astype(np.float32) * np.array([0.93, 0.96, 0.98], np.float32)).clip(0, 255)  # warm off-white paper

W, H = 2000, 1300
# a pinhole camera (f = 0.75 x width, like a phone's main camera) looking at the paper from above, tilted and turned
def camera_corners(yaw, pitch, roll, dist, f=0.75 * W):
    a = pw / ph
    out = []
    for x, y in [(-a / 2, -0.5), (a / 2, -0.5), (a / 2, 0.5), (-a / 2, 0.5)]:
        x, y = x * np.cos(roll) - y * np.sin(roll), x * np.sin(roll) + y * np.cos(roll)
        x1, z1 = x * np.cos(yaw), -x * np.sin(yaw)
        y2, z2 = y * np.cos(pitch) - z1 * np.sin(pitch), y * np.sin(pitch) + z1 * np.cos(pitch) + dist
        out.append([round(float(W / 2 + f * x1 / z2), 1), round(float(H / 2 + f * y2 / z2), 1)])
    return out
corners = camera_corners(yaw=0.1, pitch=-0.42, roll=-0.03, dist=2.55)  # TL, TR, BR, BL of the paper in the photo
M = cv2.getPerspectiveTransform(np.float32([[0, 0], [pw, 0], [pw, ph], [0, ph]]), np.float32(corners))
table = np.full((H, W, 3), (52, 60, 70), np.float32) + rng.normal(0, 6, (H, W, 1)).astype(np.float32)
table = cv2.GaussianBlur(table, (0, 0), 3)
warped = cv2.warpPerspective(paper, M, (W, H), flags=cv2.INTER_LINEAR)
mask = cv2.warpPerspective(np.ones((ph, pw), np.float32), M, (W, H), flags=cv2.INTER_LINEAR)[..., None]
photo = warped * mask + table * (1 - mask)

# light falls off from the top left; a soft shadow over the lower right
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
light = 1.0 - 0.28 * (xx / W * 0.6 + yy / H * 0.4)
light -= 0.12 * np.exp(-(((xx - 1650) / 420) ** 2 + ((yy - 980) / 260) ** 2))
photo *= light[..., None]
photo = cv2.GaussianBlur(photo, (0, 0), 1.1)
photo += rng.normal(0, 4.0, photo.shape).astype(np.float32)
photo = photo.clip(0, 255).astype(np.uint8)
ok, jpg = cv2.imencode('.jpg', photo, [cv2.IMWRITE_JPEG_QUALITY, 82])
open(os.path.join(out_dir, 'photo.jpg'), 'wb').write(jpg.tobytes())
photo = cv2.imdecode(jpg, cv2.IMREAD_COLOR)

json.dump({'corners': corners, 'paper': [pw, ph], 'margin': m}, open(os.path.join(out_dir, 'photo.json'), 'w'))
R = cv2.getPerspectiveTransform(np.float32(corners), np.float32([[0, 0], [pw, 0], [pw, ph], [0, ph]]))
cv2.imwrite(rectified_path, cv2.warpPerspective(photo, R, (pw, ph), flags=cv2.INTER_LINEAR))
print('photo', photo.shape, 'paper', pw, ph)
