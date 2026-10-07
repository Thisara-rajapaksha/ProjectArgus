import { createContext, useContext, useEffect, useRef, useState } from "react";

const CAMS = ["Front door", "Garage", "Back yard", "Lobby", "Parking", "Side gate"].map((name, i) => ({ id: i + 1, name }));
const W = 16, H = 9; // zones live in a 16x9 space so circles stay round
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
const ago = ts => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 10 ? "Just now" : s < 60 ? `${s} seconds ago` : s < 3600 ? `${Math.floor(s / 60)} minutes ago`
    : new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const api = (url, method = "GET", body) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
    .then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
const toPoly = s => {          // the backend takes polygons with x, y in 0..1
  const n = ([x, y]) => [x / W, y / H];
  if (s.t === "rect") return [[s.x, s.y], [s.x + s.w, s.y], [s.x + s.w, s.y + s.h], [s.x, s.y + s.h]].map(n);
  if (s.t === "circle") return Array.from({ length: 48 }, (_, i) => n([s.cx + s.r * Math.cos((i / 48) * 2 * Math.PI), s.cy + s.r * Math.sin((i / 48) * 2 * Math.PI)]));
  return s.pts.map(n);
};
const COLORS = ["red", "orange", "yellow", "green", "blue"];
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

function useBackend() {
  const [health, setHealth] = useState(null);
  const [events, setEvents] = useState([]);
  useEffect(() => {
    const load = () => api("/api/health").then(setHealth).catch(() => setHealth(null));
    load();
    const t = setInterval(load, 2000);
    const es = new EventSource("/api/events/stream");        // new alerts arrive instantly
    es.onmessage = m => setEvents(l => [JSON.parse(m.data), ...l].slice(0, 50));
    return () => { clearInterval(t); es.close(); };
  }, []);
  useEffect(() => { if (health) api("/api/events").then(setEvents).catch(() => {}); }, [!!health]);
  const ack = ids => {
    setEvents(l => l.map(e => (ids.includes(e.id) ? { ...e, status: "acknowledged" } : e)));
    ids.forEach(id => api(`/api/events/${id}/ack`, "POST", {}).catch(() => {}));
  };
  return { health, setHealth, events, ack };
}

// One video connection from the backend, copied into every tile (browsers allow only ~6 per site).
const Src = createContext({ img: { current: null }, live: false });

const Shape = ({ s, draft }) => {
  const p = { className: draft ? "zone draft" : "zone" };
  if (s.t === "circle") return <circle cx={s.cx} cy={s.cy} r={s.r} {...p} />;
  if (s.t === "rect") return <rect x={s.x} y={s.y} width={s.w} height={s.h} {...p} />;
  return <polygon points={s.pts.map(q => q.join(",")).join(" ")} {...p} />;
};

function Feed({ zones, hot, children }) {
  const { img, live } = useContext(Src);
  const cv = useRef();
  useEffect(() => {
    let raf, t = 0;
    const tick = ts => {
      raf = requestAnimationFrame(tick);
      if (ts - t < 66) return;
      t = ts;
      const i = img.current, c = cv.current;
      if (i?.naturalWidth && c) c.getContext("2d").drawImage(i, 0, 0, c.width, c.height);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [img]);
  return (
    <div className={"feed" + (hot ? " hot" : "")}>
      <canvas ref={cv} width="640" height="360" />
      {!live && <span className="nofeed">No video</span>}
      <svg viewBox={`0 0 ${W} ${H}`} className="shapes">{zones.map((s, i) => <Shape key={i} s={s} />)}</svg>
      {children}
    </div>
  );
}

function Editor({ cam, zones, setZones, hot }) {
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
      <Feed zones={zones} hot={hot}>
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
  const { health, setHealth, events, ack } = useBackend();
  const [view, setView] = useState(0);
  const [zones, setZonesState] = useState(() => load("argus.zones", {}));
  const [panel, setPanel] = useState(false);
  const [now, setNow] = useState(Date.now());
  const imgRef = useRef(null);
  const online = !!health, live = !!health?.online;
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const push = (id, list) => api(`/api/cameras/${id}/zone`, "PUT", { zones: list.map(toPoly) }).catch(() => {});
  const setZones = (id, list) => setZonesState(z => { const n = { ...z, [id]: list }; save("argus.zones", n); return n; }) || push(id, list);
  const synced = useRef(false);
  useEffect(() => {            // when the backend comes up, send it the zones saved in this browser
    if (!online) { synced.current = false; return; }
    if (synced.current) return;
    synced.current = true;
    const saved = load("argus.zones", {});
    CAMS.forEach(c => push(c.id, saved[c.id] || []));
  }, [online]);
  const toggleArm = () => api("/api/arm", "PUT", { armed: !health.armed }).then(r => setHealth(h => ({ ...h, armed: r.armed }))).catch(() => {});
  const pickColor = c => api("/api/detector", "PUT", { color: c }).then(r => setHealth(h => ({ ...h, color: r.color, mode: r.mode }))).catch(() => {});
  const camOf = n => n.cam || 1;
  const hot = new Set([...(health?.alerts || []), ...events.filter(n => now - n.ts * 1000 < 8000).map(camOf)]);
  const unread = events.filter(n => n.status === "new").length;
  const today = events.filter(n => new Date(n.ts * 1000).toDateString() === new Date().toDateString()).length;
  const zoneCount = Object.values(zones).reduce((a, l) => a + l.length, 0);
  const open = n => { ack([n.id]); setView(camOf(n)); setPanel(false); };
  const readAll = () => ack(events.filter(n => n.status === "new").map(n => n.id));
  const test = () => api("/api/dev/fake-event", "POST", { cam: 1 + Math.floor(Math.random() * CAMS.length) }).catch(() => {});
  const cam = CAMS.find(c => c.id === view);
  const stats = [["Cameras online", live ? CAMS.length : 0], ["Alerts today", today], ["Zones drawn", zoneCount], ["Unread alerts", unread]];
  const banner = !online ? "Can't reach the backend. Open a terminal in the backend folder and run: python app.py"
    : !live ? "The backend is running but isn't getting video. Close any other program using the webcam, or start it with SOURCE set to a video file." : "";

  return (
    <Src.Provider value={{ img: imgRef, live }}>
      <img key={live ? "on" : "off"} ref={imgRef} className="src" alt="" src={live ? "/api/cameras/1/stream" : undefined} />
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
              <label className="pick">Watching for
                <select value={health?.color || "red"} disabled={!online || health.mode !== "color"} onChange={e => pickColor(e.target.value)}>
                  {COLORS.map(c => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)} objects</option>)}
                </select>
              </label>
              <label className="switch"><input type="checkbox" checked={!!health?.armed} disabled={!online} onChange={toggleArm} /><i />{health?.armed ? "Armed" : "Disarmed"}</label>
              <button className="quiet bell" onClick={() => setPanel(p => !p)} aria-label="Notifications"><Icon n="bell" />{unread > 0 && <b>{unread}</b>}</button>
            </header>
            <div className="body">
              {banner && <p className="banner" role="alert">{banner}</p>}
              {!cam ? (
                <>
                  <div className="stats">{stats.map(([l, v]) => <div key={l} className="stat"><span>{l}</span><strong>{v}</strong></div>)}</div>
                  <div className="card"><h3>All cameras</h3>
                    <div className="grid">
                      {CAMS.map(c => (
                        <button key={c.id} className="tile" onClick={() => setView(c.id)}>
                          <Feed zones={zones[c.id] || []} hot={hot.has(c.id)} />
                          <span>{c.name}</span><em>{(zones[c.id] || []).length} zones</em>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : <Editor key={cam.id} cam={cam} zones={zones[cam.id] || []} setZones={setZones} hot={hot.has(cam.id)} />}
            </div>
          </section>

          <aside className="notes" aria-label="Notifications">
            <div className="nh"><h3>Notifications</h3><button className="quiet" onClick={readAll}>Mark all read</button></div>
            {events.length === 0 && <p className="muted">No alerts yet. Draw a zone on a camera, then put the watched color inside it.</p>}
            <ul>
              {events.map(n => (
                <li key={n.id}><button onClick={() => open(n)} className={n.status === "new" ? "unread" : ""}>
                  {n.snapshot ? <img src={n.snapshot} alt="" /> : <span className="ico"><Icon n="bell" /></span>}
                  <span><b>{n.label}</b><small>{ago(n.ts * 1000)}</small></span>
                </button></li>
              ))}
            </ul>
            <button className="quiet test" onClick={test} disabled={!online}>Send test alert</button>
          </aside>
        </div>
      </div>
    </Src.Provider>
  );
}

export default function App() {
  const [user, setUser] = useState(() => load("argus.user", null));
  if (!user) return <Login onLogin={u => { save("argus.user", u); setUser(u); }} />;
  return <Dashboard user={user} onLogout={() => { localStorage.removeItem("argus.user"); setUser(null); }} />;
}