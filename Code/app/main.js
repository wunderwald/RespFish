const { app, BrowserWindow } = require("electron");
const path = require("path");
const { spawn } = require("child_process");

let bridgeProcess = null;
let mainWindow = null;

// ── Python bridge ─────────────────────────────────────────────────────────────

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

// ── Window ────────────────────────────────────────────────────────────────────

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
