const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

let bridgeProcess = null;
let mainWindow = null;

// ── Python bridge ────────────────────────────────────────────────────────────

function startBridge() {
  // Use the venv Python; fall back to system python3
  const venvPython = path.join(
    __dirname, "..", ".venv", "bin",
    process.platform === "win32" ? "python.exe" : "python3"
  );
  const bridgeScript = path.join(__dirname, "..", "lsl_bridge", "main.py");

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

// ── Window ───────────────────────────────────────────────────────────────────

function createWindow() {
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

  // Grant camera (and microphone) access so WebGazer can use the webcam.
  // On macOS, Electron does not forward getUserMedia permission requests to
  // the OS unless this handler explicitly allows them.
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_webContents, permission, callback) => {
      if (permission === "media") {
        callback(true);
      } else {
        callback(false);
      }
    }
  );

  mainWindow.loadFile("index.html");
  mainWindow.on("closed", () => (mainWindow = null));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  startBridge();
  // Brief delay so the bridge socket is ready before the renderer connects
  setTimeout(createWindow, 600);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  killBridge();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", killBridge);