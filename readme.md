# Argus

A security camera dashboard. It shows 6 camera tiles, lets you draw alert zones (circle, rectangle, polygon) on each camera, and sends a notification when something moves inside a zone.

This version runs entirely in the browser using your laptop's webcam. You don't need the Python backend to try it.

## What you need

- A laptop with a webcam
- A browser (Chrome, Edge or Brave)
- Node.js version 18 or newer
- Git

## 1. Install the tools (skip any you already have)

**Node.js:** download the LTS version from https://nodejs.org and run the installer with the default options.

**Git:** download from https://git-scm.com/downloads and run the installer with the default options.

Close and reopen your terminal afterwards (PowerShell on Windows, Terminal on Mac), then check both installed:

```
node --version
git --version
```

Both should print a version number. `node` must show v18 or higher.

## 2. Download the project

```
git clone https://github.com/Thisara-rajapaksha/ProjectArgus.git
cd ProjectArgus
```

If you see a folder named `argus-dashboard` inside, run `cd argus-dashboard` as well.

## 3. Start the dashboard

```
cd frontend
npm install
npm run dev
```

`npm install` downloads the libraries and takes a minute the first time. When `npm run dev` finishes starting, it prints a line like:

```
Local:   http://localhost:5173/
```

Open that address in your browser.

## 4. Use it

1. Sign in with any email and a password of 4 or more characters. This is a demo login with no real accounts.
2. When the browser asks for camera access, click **Allow**. The page must be opened on `localhost` for the camera to work.
3. Click a camera in the left sidebar (or one of the tiles) to open it.
4. Pick **Circle**, **Rectangle** or **Polygon** and draw a zone on the video.
   - Circle and Rectangle: click and drag.
   - Polygon: click each corner, then click the first point to close the shape.
5. Move inside the zone for about one second. An alert appears in the Notifications panel on the right, and that camera's tile turns red.
6. Use **Send test alert** at the bottom of the notifications panel to see an alert without moving.

Zones and alerts are saved in your browser, so they stay after you reload.

To stop the dashboard, press Ctrl+C in the terminal.

## Troubleshooting

**The camera tiles are black.** Read the message in the orange banner at the top of the page. It names the cause:
- Blocked by the browser: click the lock icon in the address bar, set Camera to Allow, then reload.
- Another program is using the webcam: close Zoom, Teams, the Windows Camera app or anything else using it, then reload.
- No webcam found: check that a camera is connected and enabled in your system privacy settings.

**`npm` is not recognized.** Node.js isn't installed, or the terminal was opened before installing it. Close the terminal, open a new one and try again.

**The page won't load at localhost:5173.** Check that `npm run dev` is still running in the terminal, and use the exact address it printed (the port can differ).

## Optional: Python backend

The backend (`backend/app.py`) adds color detection, saved events with snapshots, and support for CCTV or Raspberry Pi video. The current dashboard does not use it yet.

The backend and the browser both want the same webcam, and most laptops let only one program use it at a time. Don't run both with the webcam.

You need Python 3.10 or newer.

```
cd backend
pip install -r requirements.txt
python app.py
```

`ultralytics` in `requirements.txt` is a very large download. Delete that line first if you only need color detection.

To use a video file instead of the webcam (Windows PowerShell):

```
$env:SOURCE="cctv.mp4"; python app.py
```