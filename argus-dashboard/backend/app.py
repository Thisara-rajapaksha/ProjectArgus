"""Argus backend: Flask + OpenCV + SQLite.

Install:  pip install -r requirements.txt
Run:      python app.py                                          (webcam 0)
          SOURCE=cctv.mp4 python app.py                          (video file, loops)
          SOURCE="rtsp://user:pass@IP:554/PATH" python app.py    (DVR / IP stream)
Options:  LOITER_SECONDS=3   how long something must stay in the zone before an alert
          WATCH=person,dog   what to alert on (any COCO class: person, dog, cat, car, ...)
          MODEL=yolov8n.pt   YOLO weights (downloaded on first run); IMGSZ=640 (use 320 on a Pi)
          DETECTOR=color     what finds things: color (default), yolo, or hog (basic person detector)
          COLOR=red          the color to watch for (red, orange, yellow, green, blue);
                             the dashboard can change it while running
"""
import json
import os
import queue
import sqlite3
import threading
import time

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

SOURCE = os.environ.get("SOURCE", "0")
LOITER_SECONDS = float(os.environ.get("LOITER_SECONDS", "3"))
MAX_WIDTH = 640                                   # bigger frames are shrunk (speed)
WATCH = [n.strip() for n in os.environ.get("WATCH", "person,dog").split(",")]
MIN_AREA = 500                                    # color blobs smaller than this (pixels) are ignored
KERNEL = np.ones((5, 5), np.uint8)
COLORS = {  # HSV ranges (OpenCV hue is 0-179). Red wraps around, so it has two ranges.
    "red":    [((0, 120, 70), (10, 255, 255)), ((170, 120, 70), (179, 255, 255))],
    "orange": [((10, 120, 70), (22, 255, 255))],
    "yellow": [((22, 100, 70), (35, 255, 255))],
    "green":  [((36, 70, 50), (85, 255, 255))],
    "blue":   [((90, 100, 50), (130, 255, 255))],
}
HERE = os.path.dirname(os.path.abspath(__file__))
MEDIA = os.path.join(HERE, "media")
DB = os.path.join(HERE, "guard.db")
ZONE_FILE = os.path.join(HERE, "zone.json")
os.makedirs(MEDIA, exist_ok=True)
if "://" in SOURCE:                               # TCP is more reliable for CCTV streams
    os.environ.setdefault("OPENCV_FFMPEG_CAPTURE_OPTIONS", "rtsp_transport;tcp")

app = Flask(__name__)
FONT = cv2.FONT_HERSHEY_SIMPLEX
hog = cv2.HOGDescriptor()
hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())

model, WATCH_IDS = None, []
if os.environ.get("DETECTOR", "yolo") == "yolo":
    try:
        from ultralytics import YOLO
        model = YOLO(os.environ.get("MODEL", "yolov8n.pt"))       # downloads on first run
        WATCH_IDS = [i for i, n in model.names.items() if n in WATCH]
        print("YOLO ready, watching:", [model.names[i] for i in WATCH_IDS])
    except ImportError:
        print("ultralytics is not installed, so using the basic HOG person detector")

state = {"armed": True, "online": False, "fps": 0.0, "alert": False,
         "mode": os.environ.get("DETECTOR", "color"),
         "color": os.environ.get("COLOR", "red") if os.environ.get("COLOR", "red") in COLORS else "red",
         "zone": json.load(open(ZONE_FILE)) if os.path.exists(ZONE_FILE) else None}
latest = {"jpeg": None, "raw": None}              # newest picture / newest clean frame
people = []                                       # [(x, y, w, h, score)] in 0..1
subscribers = []                                  # one queue per open event stream


# ---------- database ----------
def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c


with db() as c:
    c.execute("""CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, type TEXT, label TEXT,
        score REAL, snapshot TEXT, status TEXT DEFAULT 'new')""")


def add_event(kind, label, score, jpeg):
    ts = time.time()
    name = f"{int(ts * 1000)}.jpg"
    if jpeg:
        with open(os.path.join(MEDIA, name), "wb") as f:
            f.write(jpeg)
    with db() as c:
        cur = c.execute("INSERT INTO events (ts, type, label, score, snapshot) VALUES (?,?,?,?,?)",
                        (ts, kind, label, score, f"/media/{name}" if jpeg else None))
        row = dict(c.execute("SELECT * FROM events WHERE id=?", (cur.lastrowid,)).fetchone())
    for q in list(subscribers):                   # push to every open dashboard
        q.put(json.dumps(row))
    return row


# ---------- video ----------
def zone_poly(w, h):
    z = state["zone"]
    if not z:
        return None
    return np.array([[int(x * w), int(y * h)] for x, y in z], np.int32).reshape(-1, 1, 2)


def publish(frame):
    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if ok:
        latest["jpeg"] = jpg.tobytes()


def draw(frame):
    h, w = frame.shape[:2]
    poly = zone_poly(w, h)
    if poly is not None:
        cv2.polylines(frame, [poly], True, (0, 0, 255) if state["alert"] else (0, 200, 0), 3)
    for x, y, bw, bh, s, name in list(people):
        x1, y1, x2, y2 = int(x * w), int(y * h), int((x + bw) * w), int((y + bh) * h)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (255, 200, 0), 2)
        cv2.putText(frame, f"{name} {s:.1f}", (x1, max(y1 - 6, 14)), FONT, 0.5, (255, 200, 0), 1)
        cv2.circle(frame, ((x1 + x2) // 2, min(int(y1 + (y2 - y1) * anchor_y()), h - 1)), 5, (255, 200, 0), -1)


def open_source():
    return cv2.VideoCapture(int(SOURCE) if SOURCE.isdigit() else SOURCE)


def capture_loop():
    is_file = os.path.isfile(SOURCE)
    cap = open_source()
    delay = 1.0 / (cap.get(cv2.CAP_PROP_FPS) or 25) if is_file else 0
    fails, count, t_fps = 0, 0, time.time()
    while True:
        t0 = time.time()
        ok, frame = cap.read() if cap.isOpened() else (False, None)
        if not ok:
            if is_file and cap.isOpened():
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)   # video ended: play it again
                time.sleep(0.02)
                continue
            state["online"] = False
            fails += 1
            if fails % 20 == 0:                       # retry about every 2 seconds
                cap.release()
                cap = open_source()
            msg = np.full((360, 640, 3), 40, np.uint8)
            cv2.putText(msg, "No video source", (180, 190), FONT, 0.9, (200, 200, 200), 2)
            publish(msg)
            time.sleep(0.1)
            continue
        fails = 0
        state["online"] = True
        if frame.shape[1] > MAX_WIDTH:
            frame = cv2.resize(frame, None, fx=MAX_WIDTH / frame.shape[1], fy=MAX_WIDTH / frame.shape[1])
        latest["raw"] = frame.copy()                  # clean copy for the detector
        draw(frame)
        publish(frame)
        count += 1
        if time.time() - t_fps >= 1:
            state["fps"], count, t_fps = round(count / (time.time() - t_fps), 1), 0, time.time()
        if delay:
            time.sleep(max(0.0, delay - (time.time() - t0)))


def anchor_y():
    """Which point of a box must be inside the zone: the middle for colors, the feet for people."""
    return 0.5 if state["mode"] == "color" else 1.0


def find_color(frame, color):
    """Blobs of one color: [(x, y, w, h, score, name)], all in 0..1."""
    h, w = frame.shape[:2]
    hsv = cv2.cvtColor(cv2.GaussianBlur(frame, (7, 7), 0), cv2.COLOR_BGR2HSV)
    mask = None
    for lo, hi in COLORS[color]:
        part = cv2.inRange(hsv, np.array(lo), np.array(hi))
        mask = part if mask is None else cv2.bitwise_or(mask, part)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, KERNEL)     # remove speckles
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, KERNEL)    # fill small holes
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in contours:
        if cv2.contourArea(c) >= MIN_AREA:
            x, y, bw, bh = cv2.boundingRect(c)
            out.append((x / w, y / h, bw / w, bh / h, 1.0, f"{color} object"))
    return out


def find_objects(frame):
    """Everything the current detector finds: [(x, y, w, h, score, name)], all in 0..1."""
    if state["mode"] == "color":
        return find_color(frame, state["color"])
    h, w = frame.shape[:2]
    out = []
    if model is not None:                             # YOLO
        r = model(frame, imgsz=int(os.environ.get("IMGSZ", "640")), conf=0.4,
                  classes=WATCH_IDS, verbose=False)[0]
        for b in r.boxes:
            x1, y1, x2, y2 = b.xyxy[0].tolist()
            out.append((x1 / w, y1 / h, (x2 - x1) / w, (y2 - y1) / h,
                        float(b.conf[0]), r.names[int(b.cls[0])]))
        return out
    rects, scores = hog.detectMultiScale(frame, winStride=(8, 8), padding=(8, 8), scale=1.08)
    if len(rects):                                    # basic HOG fallback: people only
        boxes = [[int(x), int(y), int(bw), int(bh)] for x, y, bw, bh in rects]
        sc = [float(v) for v in np.array(scores).flatten()]
        for i in np.array(cv2.dnn.NMSBoxes(boxes, sc, 0.5, 0.4)).flatten():
            x, y, bw, bh = boxes[i]
            out.append((x / w, y / h, bw / w, bh / h, sc[i], "person"))
    return out


def detect_loop():
    """Find people, check whether their feet are in the zone, raise a loitering alert."""
    global people
    last, since, last_seen, alerted = None, None, 0.0, False
    while True:
        raw = latest["raw"]
        if raw is None or raw is last:
            time.sleep(0.02)
            continue
        last = raw
        try:
            h, w = raw.shape[:2]
            found = find_objects(raw)
            people = found
            poly, inside = zone_poly(w, h), None
            if poly is not None:
                for x, y, bw, bh, s, name in found:
                    feet = (float((x + bw / 2) * w), float(min((y + bh * anchor_y()) * h, h - 1)))
                    if cv2.pointPolygonTest(poly, feet, False) >= 0:
                        inside = (s, name)
                        break
            now = time.time()
            if inside is not None:
                since = since or now
                last_seen = now
                state["alert"] = True
                if state["armed"] and not alerted and now - since >= LOITER_SECONDS:
                    alerted = True
                    add_event("loitering", f"{inside[1].capitalize()} in the zone for {now - since:.0f} s",
                              inside[0], latest["jpeg"])
            elif since and now - last_seen > 2:       # zone empty for 2 s: reset
                since, alerted, state["alert"] = None, False, False
        except Exception as e:                        # keep the thread alive
            print("detection error:", e)
            time.sleep(1)


def mjpeg():
    while True:
        data = latest["jpeg"]
        if data:
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n"
        time.sleep(0.04)


def cpu_temp():
    try:
        with open("/sys/class/thermal/thermal_zone0/temp") as f:
            return round(int(f.read()) / 1000, 1)
    except (OSError, ValueError):
        return None


# ---------- API ----------
@app.get("/api/cameras")
def cameras():
    return jsonify([{"id": 1, "name": "Camera 1", "online": state["online"],
                     "armed": state["armed"], "zone": state["zone"]}])


@app.get("/api/cameras/<int:cid>/stream")
def stream(cid):
    return Response(mjpeg(), mimetype="multipart/x-mixed-replace; boundary=frame")


@app.get("/api/cameras/<int:cid>/snapshot")
def snapshot(cid):
    return Response(latest["jpeg"] or b"", mimetype="image/jpeg")


@app.route("/api/cameras/<int:cid>/zone", methods=["GET", "PUT"])
def zone(cid):
    """PUT {"zone": [[x, y], ...]} with x, y in 0..1, or {"zone": null} to remove it."""
    if request.method == "PUT":
        z = (request.get_json(silent=True) or {}).get("zone")
        if z is not None:
            try:
                z = [[min(1.0, max(0.0, float(x))), min(1.0, max(0.0, float(y)))] for x, y in z]
            except (TypeError, ValueError):
                return jsonify(error="bad zone"), 400
            if not 3 <= len(z) <= 200:
                return jsonify(error="a zone needs 3 to 200 points"), 400
        state["zone"], state["alert"] = z, False
        with open(ZONE_FILE, "w") as f:
            json.dump(z, f)
    return jsonify(zone=state["zone"])


@app.get("/api/events")
def events():
    limit = min(int(request.args.get("limit", 50)), 200)
    with db() as c:
        rows = c.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return jsonify([dict(r) for r in rows])


@app.post("/api/events/<int:eid>/ack")
def ack(eid):
    status = "false_alarm" if (request.get_json(silent=True) or {}).get("false_alarm") else "acknowledged"
    with db() as c:
        c.execute("UPDATE events SET status=? WHERE id=?", (status, eid))
    return jsonify(id=eid, status=status)


@app.get("/api/events/stream")
def events_stream():
    q = queue.Queue()
    subscribers.append(q)

    def gen():
        try:
            while True:
                try:
                    yield f"data: {q.get(timeout=15)}\n\n"
                except queue.Empty:
                    yield ": keep-alive\n\n"
        finally:
            subscribers.remove(q)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.put("/api/arm")
def arm():
    state["armed"] = bool((request.get_json(silent=True) or {}).get("armed"))
    return jsonify(armed=state["armed"])


@app.get("/api/health")
def health():
    return jsonify(**{k: state[k] for k in ("online", "armed", "fps", "alert", "mode", "color")}, cpu_temp=cpu_temp())


@app.route("/api/detector", methods=["GET", "PUT"])
def detector():
    """PUT {"color": "red"} switches to color detection for that color."""
    if request.method == "PUT":
        color = (request.get_json(silent=True) or {}).get("color")
        if color not in COLORS:
            return jsonify(error=f"color must be one of {list(COLORS)}"), 400
        state["mode"], state["color"], state["alert"] = "color", color, False
    return jsonify(mode=state["mode"], color=state["color"], colors=list(COLORS))


@app.post("/api/dev/fake-event")
def fake_event():                                 # to test the dashboard without detection
    return jsonify(add_event("test", "Test event (fake)", 0.99, latest["jpeg"]))


@app.get("/media/<path:name>")
def media(name):
    return send_from_directory(MEDIA, name)


if __name__ == "__main__":
    threading.Thread(target=capture_loop, daemon=True).start()
    threading.Thread(target=detect_loop, daemon=True).start()
    print(f"Argus backend on http://127.0.0.1:5000  (source: {'stream' if '://' in SOURCE else SOURCE})")
    app.run(host="127.0.0.1", port=5000, threaded=True)
