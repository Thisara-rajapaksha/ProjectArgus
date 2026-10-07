import { useCallback, useEffect, useRef, useState } from "react";

const CAMS = ["Front door", "Garage", "Back yard", "Lobby", "Parking", "Side gate"].map((name, i) => ({ id: i + 1, name }));
const W = 16, H = 9; // zones live in a 16x9 space so circles stay round
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const ago = ts => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 10 ? "Just now" : s < 60 ? `${s} seconds ago` : s < 3600 ? `${Math.floor(s / 60)} minutes ago`
    : new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const kind = s => (s.t === "rect" ? "Rectangle" : s.t === "circle" ? "Circle" : "Polygon");

function inside(s, x, y) {
  if (s.t === "circle") return (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2;
  if (s.t === "rect") return x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h;
  let c = false; const p = s.pts;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++)
    if ((p[i][1] > y) !== (p[j][1] > y) && x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0]) c = !c;
  return c;
}

const Icon = ({ n }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {{
      grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
      cam: <><path d="M3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="m15 11 6-3v8l-6-3" /></>,
      bell: <><path d="M6 9a6 6 0 1 1 12 0c0 6 2 7 2 7H4s2-1 2-7" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
      out: <><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4" /><path d="m16 8 4 4-4 4M20 12H9" /></>,
    }[n]}
  </svg>
);

function useWebcam() {
  const [stream, setStream] = useState(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let s, gone = false;
    const why = {
      NotAllowedError: "The browser blocked the camera. Click the lock icon in the address bar, set Camera to Allow, and reload.",
      NotReadableError: "Another program is using the webcam, so the browser can't open it. Stop the Flask backend (python app.py) and any other app using the camera, then reload.",
      NotFoundError: "No webcam was found on this computer.",
      OverconstrainedError: "The webcam doesn't support the requested size.",
    };
    if (!navigator.mediaDevices?.getUserMedia) { setError("This page can't use the camera. Open it on localhost or https."); return; }
    navigator.mediaDevices.getUserMedia({ video: true })
      .then(m => (gone ? m.getTracks().forEach(t => t.stop()) : (s = m, setStream(m))))
      .catch(e => setError((why[e.name] || "Could not open the webcam.") + ` (${e.name})`));
    return () => { gone = true; s?.getTracks().forEach(t => t.stop()); };
  }, []);
  return { stream, error };
}

// Motion inside a camera's zones for 1 s raises an alert (10 s cooldown per camera).
function useDetector(stream, zones, armed, onAlert) {
  const live = useRef({});
  live.current = { zones, armed, onAlert };
  useEffect(() => {
    if (!stream) return;
    const v = document.createElement("video");
    v.srcObject = stream; v.muted = true; v.play().catch(() => {});
    const c = document.createElement("canvas"); c.width = 64; c.height = 36;
    const g = c.getContext("2d", { willReadFrequently: true });
    const snap = document.createElement("canvas"); snap.width = 320; snap.height = 180;
    let prev = null; const since = {}, last = {};
    const t = setInterval(() => {
      if (v.readyState < 2) return;
      g.drawImage(v, 0, 0, 64, 36);
      const d = g.getImageData(0, 0, 64, 36).data;
      const p = prev; prev = d;
      if (!p) return;
      const { zones, armed, onAlert } = live.current, now = Date.now();
      for (const cam of CAMS) {
        const zs = zones[cam.id] || [];
        if (!zs.length || !armed) { since[cam.id] = 0; continue; }
        let n = 0, hit = 0;
        for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
          const px = ((x + 0.5) / 64) * W, py = ((y + 0.5) / 36) * H;
          if (!zs.some(s => inside(s, px, py))) continue;
          n++; const i = (y * 64 + x) * 4;
          if (Math.abs(d[i] - p[i]) + Math.abs(d[i + 1] - p[i + 1]) + Math.abs(d[i + 2] - p[i + 2]) > 90) hit++;
        }
        if (n && hit / n > 0.06) {
          since[cam.id] = since[cam.id] || now;
          if (now - since[cam.id] >= 1000 && now - (last[cam.id] || 0) > 10000) {
            last[cam.id] = now;
            snap.getContext("2d").drawImage(v, 0, 0, 320, 180);
            onAlert(cam, snap.toDataURL("image/jpeg", 0.6));
          }
        } else since[cam.id] = 0;
      }
    }, 250);
    return () => clearInterval(t);
  }, [stream]);
}

const Shape = ({ s, draft }) => {
  const p = { className: draft ? "zone draft" : "zone" };
  if (s.t === "circle") return <circle cx={s.cx} cy={s.cy} r={s.r} {...p} />;
  if (s.t === "rect") return <rect x={s.x} y={s.y} width={s.w} height={s.h} {...p} />;
  return <polygon points={s.pts.map(q => q.join(",")).join(" ")} {...p} />;
};

function Feed({ stream, zones, hot, children }) {
  const ref = useRef();
  useEffect(() => { if (ref.current && stream) ref.current.srcObject = stream; }, [stream]);
  return (
    <div className={"feed" + (hot ? " hot" : "")}>
      <video ref={ref} autoPlay muted playsInline />
      {!stream && <span className="nofeed">No webcam feed</span>}
      <svg viewBox={`0 0 ${W} ${H}`} className="shapes">{zones.map((s, i) => <Shape key={i} s={s} />)}</svg>
      {children}
    </div>
  );
}

function Editor({ cam, stream, zones, setZones, hot }) {
  const [tool, setTool] = useState("circle");
  const [draft, setDraft] = useState(null);
  const svg = useRef();
  const pick = t => { setTool(t); setDraft(null); };
  const pt = e => { const r = svg.current.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H]; };
  const commit = s => { setZones(cam.id, [...zones, s]); setDraft(null); };
  const down = e => {
    const [x, y] = pt(e);
    if (tool === "poly") {
      if (draft?.pts.length > 2 && Math.hypot(x - draft.pts[0][0], y - draft.pts[0][1]) < 0.4) return commit(draft);
      return setDraft({ t: "poly", pts: [...(draft?.pts || []), [x, y]] });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    setDraft(tool === "circle" ? { t: "circle", cx: x, cy: y, r: 0 } : { t: "rect", x, y, w: 0, h: 0, ox: x, oy: y });
  };
  const move = e => {
    if (!draft || tool === "poly") return;
    const [x, y] = pt(e);
    setDraft(d => d.t === "circle" ? { ...d, r: Math.hypot(x - d.cx, y - d.cy) }
      : { ...d, x: Math.min(x, d.ox), y: Math.min(y, d.oy), w: Math.abs(x - d.ox), h: Math.abs(y - d.oy) });
  };
  const up = () => {
    if (!draft || tool === "poly") return;
    if (draft.t === "circle" ? draft.r > 0.2 : draft.w > 0.3 && draft.h > 0.3) { const { ox, oy, ...s } = draft; commit(s); }
    else setDraft(null);
  };
  const hints = { circle: "Click and drag from the center outward.", rect: "Click and drag across the area.", poly: "Click each corner. Click the first point to close the shape." };
  return (
    <div className="cam-layout">
      <Feed stream={stream} zones={zones} hot={hot}>
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="draw" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
          {draft && <Shape s={draft} draft />}
          {draft?.t === "poly" && draft.pts.map((q, i) => <circle key={i} cx={q[0]} cy={q[1]} r="0.08" className="dot" />)}
        </svg>
      </Feed>
      <div className="card">
        <h3>Zone tools</h3>
        <div className="seg" role="group" aria-label="Shape">
          {[["circle", "Circle"], ["rect", "Rectangle"], ["poly", "Polygon"]].map(([id, label]) => (
            <button key={id} className={tool === id ? "on" : ""} aria-pressed={tool === id} onClick={() => pick(id)}>{label}</button>
          ))}
        </div>
        <p className="muted">{hints[tool]}</p>
        {draft?.t === "poly" && draft.pts.length > 2 && <button className="primary" onClick={() => commit(draft)}>Finish shape</button>}
        <h3>Zones on {cam.name}</h3>
        {zones.length === 0 && <p className="muted">No zones yet. Draw one to get alerts when something moves inside it.</p>}
        <ul className="zlist">
          {zones.map((s, i) => (
            <li key={i}><span>{kind(s)} {i + 1}</span>
              <button className="quiet" onClick={() => setZones(cam.id, zones.filter((_, j) => j !== i))}>Delete</button></li>
          ))}
        </ul>
        {zones.length > 1 && <button className="quiet" onClick={() => setZones(cam.id, [])}>Delete all zones</button>}
      </div>
    </div>
  );
}

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = e => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email)) return setErr("Enter a valid email address.");
    if (pw.length < 4) return setErr("Password must be at least 4 characters.");
    const n = email.split("@")[0];
    onLogin({ email, name: n[0].toUpperCase() + n.slice(1) });
  };
  return (
    <div className="page">
      <div className="login">
        <div className="login-art"><h1>Argus</h1><p>Your virtual security guard. Watch every camera and get an alert when something moves inside a zone you drew.</p></div>
        <form onSubmit={submit} noValidate>
          <h2>Sign in</h2>
          <label>Email<input value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
          <label>Password<input type="password" value={pw} onChange={e => setPw(e.target.value)} autoComplete="current-password" /></label>
          {err && <p className="err" role="alert">{err}</p>}
          <button className="primary">Sign in</button>
          <p className="muted">Demo mode: any email and a password of 4 or more characters works.</p>
        </form>
      </div>
    </div>
  );
}

function Dashboard({ user, onLogout }) {
  const { stream, error } = useWebcam();
  const [view, setView] = useState(0);
  const [zones, setZonesState] = useState(() => load("argus.zones", {}));
  const [notes, setNotes] = useState(() => load("argus.notes", []));
  const [armed, setArmed] = useState(true);
  const [panel, setPanel] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const setZones = (id, list) => setZonesState(z => { const n = { ...z, [id]: list }; save("argus.zones", n); return n; });
  const addNote = useCallback((cam, label, img) => setNotes(l => {
    const n = [{ id: Date.now() + Math.random(), cam: cam.id, label, ts: Date.now(), img, read: false }, ...l].slice(0, 30);
    save("argus.notes", n); return n;
  }), []);
  useDetector(stream, zones, armed, (cam, img) => addNote(cam, `Movement in the ${cam.name} zone`, img));
  const hot = new Set(notes.filter(n => now - n.ts < 8000).map(n => n.cam));
  const unread = notes.filter(n => !n.read).length;
  const today = notes.filter(n => new Date(n.ts).toDateString() === new Date().toDateString()).length;
  const zoneCount = Object.values(zones).reduce((a, l) => a + l.length, 0);
  const open = n => { setNotes(l => { const x = l.map(m => (m.id === n.id ? { ...m, read: true } : m)); save("argus.notes", x); return x; }); setView(n.cam); setPanel(false); };
  const readAll = () => setNotes(l => { const x = l.map(m => ({ ...m, read: true })); save("argus.notes", x); return x; });
  const test = () => { const c = CAMS[Math.floor(Math.random() * CAMS.length)]; addNote(c, `Test alert from ${c.name}`); };
  const cam = CAMS.find(c => c.id === view);
  const stats = [["Cameras online", stream ? CAMS.length : 0], ["Alerts today", today], ["Zones drawn", zoneCount], ["Unread alerts", unread]];

  return (
    <div className="page">
      <div className={"shell" + (panel ? " show-panel" : "")}>
        <aside className="side">
          <div className="logo">Argus</div>
          <nav aria-label="Main">
            <p className="group">Dashboards</p>
            <button className={"nav" + (!view ? " on" : "")} onClick={() => setView(0)}><Icon n="grid" />Overview</button>
            <p className="group">Cameras</p>
            {CAMS.map(c => (
              <button key={c.id} className={"nav" + (view === c.id ? " on" : "")} onClick={() => setView(c.id)}>
                <Icon n="cam" />{c.name}{hot.has(c.id) && <span className="pulse" aria-label="Alert" />}
              </button>
            ))}
          </nav>
          <div className="spacer" />
          <div className="user"><span>{user.name}</span><button className="quiet" onClick={onLogout} aria-label="Sign out"><Icon n="out" /></button></div>
        </aside>

        <section className="main">
          <header className="top">
            <p className="crumb">{cam ? "Cameras" : "Dashboards"} <span>/</span> <b>{cam ? cam.name : "Overview"}</b></p>
            <label className="switch"><input type="checkbox" checked={armed} onChange={() => setArmed(a => !a)} /><i />{armed ? "Armed" : "Disarmed"}</label>
            <button className="quiet bell" onClick={() => setPanel(p => !p)} aria-label="Notifications"><Icon n="bell" />{unread > 0 && <b>{unread}</b>}</button>
          </header>
          <div className="body">
            {error && <p className="banner" role="alert">{error}</p>}
            {!cam ? (
              <>
                <div className="stats">{stats.map(([l, v]) => <div key={l} className="stat"><span>{l}</span><strong>{v}</strong></div>)}</div>
                <div className="card"><h3>All cameras</h3>
                  <div className="grid">
                    {CAMS.map(c => (
                      <button key={c.id} className="tile" onClick={() => setView(c.id)}>
                        <Feed stream={stream} zones={zones[c.id] || []} hot={hot.has(c.id)} />
                        <span>{c.name}</span><em>{(zones[c.id] || []).length} zones</em>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : <Editor key={cam.id} cam={cam} stream={stream} zones={zones[cam.id] || []} setZones={setZones} hot={hot.has(cam.id)} />}
          </div>
        </section>

        <aside className="notes" aria-label="Notifications">
          <div className="nh"><h3>Notifications</h3><button className="quiet" onClick={readAll}>Mark all read</button></div>
          {notes.length === 0 && <p className="muted">No alerts yet. Draw a zone on a camera, then move inside it.</p>}
          <ul>
            {notes.map(n => (
              <li key={n.id}><button onClick={() => open(n)} className={n.read ? "" : "unread"}>
                {n.img ? <img src={n.img} alt="" /> : <span className="ico"><Icon n="bell" /></span>}
                <span><b>{n.label}</b><small>{ago(n.ts)}</small></span>
              </button></li>
            ))}
          </ul>
          <button className="quiet test" onClick={test}>Send test alert</button>
        </aside>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(() => load("argus.user", null));
  if (!user) return <Login onLogin={u => { save("argus.user", u); setUser(u); }} />;
  return <Dashboard user={user} onLogout={() => { localStorage.removeItem("argus.user"); setUser(null); }} />;
}
