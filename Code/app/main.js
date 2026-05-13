const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let bridgeProcess  = null;
let mainWindow     = null;
let controlWindow  = null;
let launcherWindow = null;

// ── Python bridge ────────────────────────────────────────────────────────────

function startBridge() {
  // Use the venv Python; fall back to system python3
  const venvPython = path.join(
    __dirname, "..", ".venv", "bin",
    process.platform === "win32" ? "python.exe" : "python3"
  );
  const bridgeScript = path.join(__dirname, "..", "lsl_ws_bridge", "main.py");

  bridgeProcess = spawn(venvPython, [bridgeScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  bridgeProcess.stdout.on("data", (d) =>
    console.log("[bridge]", d.toString().trimEnd())
  );
  bridgeProcess.stderr.on("data", (d) =>
    console.error("[bridge]", d.toString().trimEnd())
  );
  bridgeProcess.on("exit", (code) =>
    console.log("[bridge] exited with code", code)
  );
  bridgeProcess.on("error", (err) =>
    console.error("[bridge] failed to start:", err.message)
  );
}

function killBridge() {
  if (bridgeProcess && !bridgeProcess.killed) {
    bridgeProcess.kill();
    bridgeProcess = null;
  }
}

// ── IPC: File I/O ────────────────────────────────────────────────────────────
//
// All file paths sent from the renderer are resolved relative to the app's
// working directory (i.e. the electron/ folder).  Absolute paths are passed
// through unchanged.  The renderer never touches the filesystem directly.

/**
 * ensure-dir
 * Creates a directory (and any missing parents) if it does not exist.
 * Returns { ok: true } or { ok: false, error: string }.
 */
ipcMain.handle("ensure-dir", (_event, dirPath) => {
  try {
    const resolved = path.isAbsolute(dirPath)
      ? dirPath
      : path.join(__dirname, dirPath);
    fs.mkdirSync(resolved, { recursive: true });
    return { ok: true };
  } catch (err) {
    console.error("[fs] ensure-dir failed:", err.message);
    return { ok: false, error: err.message };
  }
});

/**
 * write-csv
 * Writes a UTF-8 string to a file, creating parent directories as needed.
 * Overwrites any existing file at that path.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * Args:
 *   filePath  – destination path (relative to app dir, or absolute)
 *   content   – the full CSV string to write
 */
ipcMain.handle("write-csv", (_event, filePath, content) => {
  try {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(__dirname, filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, content, "utf8");
    console.log("[fs] wrote", resolved);
    return { ok: true };
  } catch (err) {
    console.error("[fs] write-csv failed:", err.message);
    return { ok: false, error: err.message };
  }
});

/**
 * append-csv
 * Appends a UTF-8 string to a file.  Creates the file (and parent dirs) if
 * it does not yet exist.  Useful for writing frame-data rows incrementally
 * rather than buffering the whole trial in memory.
 * Returns { ok: true } or { ok: false, error: string }.
 */
ipcMain.handle("append-csv", (_event, filePath, content) => {
  try {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(__dirname, filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.appendFileSync(resolved, content, "utf8");
    return { ok: true };
  } catch (err) {
    console.error("[fs] append-csv failed:", err.message);
    return { ok: false, error: err.message };
  }
});

/**
 * read-file
 * Reads a UTF-8 file and returns its content.
 * Returns { ok: true, content: string } or { ok: false, error: string }.
 */
ipcMain.handle("read-file", (_event, filePath) => {
  try {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.join(__dirname, filePath);
    const content = require("fs").readFileSync(resolved, "utf8");
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * pick-directory
 * Opens a native folder-picker dialog.
 * Returns the selected path string, or null if cancelled.
 */
ipcMain.handle("pick-directory", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: "Select data output directory",
    properties: ["openDirectory", "createDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── Experimenter control window ───────────────────────────────────────────────

function createControlWindow(frontend) {
  controlWindow = new BrowserWindow({
    width: 1100,
    height: 260,
    minWidth: 700,
    minHeight: 200,
    title: "Experimenter Controls",
    backgroundColor: "#000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWindow.loadFile("experimenter.html", { query: { frontend } });
  controlWindow.on("closed", () => {
    controlWindow = null;
    app.quit();
  });
}

// Relay: scene window → experimenter window
ipcMain.on("hud:state", (_event, data) => {
  controlWindow?.webContents.send("hud:state", data);
});

// Relay: experimenter window → scene window
ipcMain.on("hud:action", (_event, data) => {
  mainWindow?.webContents.send("hud:action", data);
});

ipcMain.on("hud:open-control", () => {
  controlWindow?.focus();
});

// Relay: scene window → experimenter window (frontend state)
ipcMain.on("frontend:state", (_event, data) => {
  controlWindow?.webContents.send("frontend:state", data);
});
// Relay: experimenter window → scene window (frontend action)
ipcMain.on("frontend:action", (_event, data) => {
  mainWindow?.webContents.send("frontend:action", data);
});

// Relay: experimenter window → scene window (resp stream data)
ipcMain.on("stream:sample", (_event, data) => {
  mainWindow?.webContents.send("stream:sample", data);
});
ipcMain.on("stream:status", (_event, data) => {
  mainWindow?.webContents.send("stream:status", data);
});
ipcMain.on("gaze:sample", (_event, data) => {
  mainWindow?.webContents.send("gaze:sample", data);
});
// Relay: scene window → experimenter window (status replay request)
ipcMain.on("stream:request-status", () => {
  controlWindow?.webContents.send("stream:request-status");
});

// ── Scene window ──────────────────────────────────────────────────────────────

function createWindow(frontend) {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 600,
    minHeight: 500,
    title: "RespFish",
    backgroundColor: "#0f485f",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile("index.html", { query: { frontend } });
  mainWindow.on("closed", () => {
    mainWindow = null;
    app.quit();
  });
}

// ── Launcher window ───────────────────────────────────────────────────────────

function createLauncherWindow() {
  launcherWindow = new BrowserWindow({
    width: 520,
    height: 430,
    resizable: false,
    title: "RespFish",
    backgroundColor: "#0b1e30",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  launcherWindow.loadFile("launcher.html");
  launcherWindow.setMenuBarVisibility(false);
  launcherWindow.on("closed", () => {
    launcherWindow = null;
    // Only quit if no experiment windows were opened
    if (!mainWindow && !controlWindow) app.quit();
  });
}

function launchFrontend(frontend) {
  // Create experiment windows FIRST so there is never a windowless moment.
  // If the launcher closes before mainWindow exists, window-all-closed fires
  // and app.quit() is called — creating the windows synchronously prevents that.
  createWindow(frontend);
  createControlWindow(frontend);
  if (launcherWindow) {
    launcherWindow.removeAllListeners("closed");
    launcherWindow.close();
    launcherWindow = null;
  }
}

// ── Camera permission ─────────────────────────────────────────────────────────
// Must be set on the default session before any window loads so that
// WebGazer's getUserMedia() call is not silently denied on macOS.

function setupPermissions() {
  const { session } = require("electron");
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      callback(permission === "media");
    }
  );
  // Also set the check handler so synchronous permission checks pass
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === "media"
  );
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

// Prevent Chromium from throttling timers and rAF when the window loses focus.
// Without this, requestAnimationFrame stalls when the app is not the active
// window, which delays state transitions and marker sends.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

app.whenReady().then(() => {
  setupPermissions();
  startBridge();

  const frontend = process.env.FRONTEND;
  if (frontend) {
    // Direct launch via `npm run ibreath` etc. — skip the launcher.
    // Brief delay so the bridge socket is ready before the renderer connects.
    setTimeout(() => {
      createWindow(frontend);
      createControlWindow(frontend);
    }, 600);
  } else {
    // No frontend specified — show the launcher so the user can choose.
    createLauncherWindow();
    ipcMain.once("launcher:select", (_event, chosen) => launchFrontend(chosen));
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createLauncherWindow();
  });
});

app.on("window-all-closed", () => {
  killBridge();
  app.quit();
});

app.on("before-quit", killBridge);