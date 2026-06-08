"""LabChart → LSL  —  channel selector and stream monitor."""

import sys
import queue
import threading
import tkinter as tk
from tkinter import messagebox

try:
    import pythoncom # windows only! pip install pywin32
    from labchart_to_lsl import (
        LabChartConnection, Config, ChannelConfig,
        create_lsl_outlet, stream_loop,
    )
except ImportError as exc:
    _r = tk.Tk()
    _r.withdraw()
    messagebox.showerror(
        "Missing dependency",
        f"{exc}\n\nRun:  pip install pywin32 pylsl",
    )
    sys.exit(1)


# Palette

BG  = "#0d0d0d"
BG2 = "#141414"
BG3 = "#1b1b1b"
BG4 = "#222222"
FG  = "#c8c8c8"
FGA = "#484848"   
FGH = "#5a5a5a"   
ACE = "#00c278"   
WRN = "#d4941a"   
ERR = "#cc4444"   
SEP = "#222222"   

MF = ("Arial", 10)
MS = ("Arial", 9)
MB = ("Arial", 10, "bold")
ML = ("Arial", 12, "bold")

PAD = 10


# Widget helpers

def _dot(canvas: tk.Canvas, color: str, r: int = 4) -> None:
    s = r * 2
    canvas.delete("all")
    canvas.create_oval(1, 1, s - 1, s - 1, fill=color, outline="")


def _sep(parent: tk.Misc) -> tk.Frame:
    return tk.Frame(parent, bg=SEP, height=1)


def _lbl(parent, text="", font=MS, fg=FGA, bg=BG, **kw) -> tk.Label:
    return tk.Label(parent, text=text, font=font, fg=fg, bg=bg, **kw)


def _btn(parent, text, cmd, fg=ACE, **kw) -> tk.Button:
    return tk.Button(
        parent, text=text, command=cmd,
        font=MB, bg=BG3, fg=fg,
        activebackground=BG4, activeforeground=fg,
        relief="flat", bd=0, padx=12, pady=4,
        cursor="hand2", **kw,
    )


def _entry(parent, var, width=20, **kw) -> tk.Entry:
    return tk.Entry(
        parent, textvariable=var, font=MF,
        bg=BG4, fg=FG, insertbackground=ACE,
        relief="flat", highlightthickness=1,
        highlightcolor=ACE, highlightbackground=SEP,
        width=width, **kw,
    )


# Channel row

class ChannelRow:
    """One row in the channel table."""

    def __init__(self, parent: tk.Frame, row: int,
                 index: int, name: str, rate: float, unit: str):
        self.index = index
        self.rate  = rate

        bg = BG2 if row % 2 == 0 else BG3

        self.enabled  = tk.BooleanVar(value=True)
        self.lsl_name = tk.StringVar(value=name)
        self.lsl_type = tk.StringVar(value="Phys")

        self._cb = tk.Checkbutton(
            parent, variable=self.enabled, command=self._on_toggle,
            bg=bg, activebackground=bg, selectcolor=BG4,
            fg=ACE, activeforeground=ACE,
            bd=0, highlightthickness=0, cursor="hand2",
        )
        self._cb.grid(row=row, column=0, padx=(PAD, 2), pady=4, sticky="w")

        self._name_lbl = _lbl(parent, name, font=MF, fg=FG, bg=bg,
                              anchor="w", width=16)
        self._name_lbl.grid(row=row, column=1, padx=4, sticky="ew")

        self._rate_lbl = _lbl(parent, f"{rate:.0f} Hz", bg=bg,
                              anchor="e", width=8)
        self._rate_lbl.grid(row=row, column=2, padx=4, sticky="ew")

        _lbl(parent, unit or "—", bg=bg, anchor="w", width=5).grid(
            row=row, column=3, padx=4, sticky="ew")

        self._e_name = _entry(parent, self.lsl_name, width=18)
        self._e_name.grid(row=row, column=4, padx=4, pady=3, sticky="ew")

        self._e_type = _entry(parent, self.lsl_type, width=7)
        self._e_type.grid(row=row, column=5, padx=(4, PAD), pady=3, sticky="ew")

        self._editable = [self._e_name, self._e_type]
        self._on_toggle()

    def _on_toggle(self):
        on = self.enabled.get()
        self._name_lbl.config(fg=FG if on else FGA)
        for w in self._editable:
            w.config(state="normal" if on else "disabled")

    def highlight_rate(self, warn: bool) -> None:
        self._rate_lbl.config(fg=WRN if warn else FGA)

    def lock(self, locked: bool) -> None:
        """Freeze all controls while streaming."""
        self._cb.config(state="disabled" if locked else "normal")
        for w in self._editable:
            if locked or not self.enabled.get():
                w.config(state="disabled")
            else:
                w.config(state="normal")

    def to_config(self) -> ChannelConfig:
        return ChannelConfig(
            index=self.index,
            lsl_name=self.lsl_name.get().strip() or f"Ch{self.index}",
            lsl_type=self.lsl_type.get().strip() or "Phys",
        )


# Main window

class App(tk.Tk):

    def __init__(self):
        super().__init__()
        self.title("LabChart → LSL")
        self.configure(bg=BG)
        self.resizable(True, True)
        self.minsize(680, 340)

        self._lc:     LabChartConnection | None = None
        self._rows:   list[ChannelRow] = []
        self._thread: threading.Thread | None = None
        self._stop:   threading.Event = threading.Event()
        self._q:      queue.Queue = queue.Queue()
        self._live:   bool = False

        self._build()
        self._conn_ui("off")
        self._stream_ui("off")
        self._poll()

    #  Layout

    def _build(self):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(5, weight=1)   # channel area stretches

        # row 0 — title
        hdr = tk.Frame(self, bg=BG, padx=PAD, pady=10)
        hdr.grid(row=0, column=0, sticky="ew")
        _lbl(hdr, "LABCHART  →  LSL", font=ML, fg=FG, bg=BG).pack(side="left")

        # row 1 — separator
        _sep(self).grid(row=1, column=0, sticky="ew")

        # row 2 — connection bar
        conn = tk.Frame(self, bg=BG2, padx=PAD, pady=8)
        conn.grid(row=2, column=0, sticky="ew")

        self._cd = tk.Canvas(conn, width=8, height=8, bg=BG2, highlightthickness=0)
        self._cd.pack(side="left", padx=(0, 5))
        self._cl = _lbl(conn, bg=BG2)
        self._cl.pack(side="left", padx=(0, 20))

        self._sd = tk.Canvas(conn, width=8, height=8, bg=BG2, highlightthickness=0)
        self._sd.pack(side="left", padx=(0, 5))
        self._sl = _lbl(conn, bg=BG2)
        self._sl.pack(side="left")

        self._conn_btn = _btn(conn, "CONNECT", self._on_connect)
        self._conn_btn.pack(side="right")

        # row 3 — separator
        _sep(self).grid(row=3, column=0, sticky="ew")

        # row 4 — rate-mismatch warning (hidden until needed)
        self._warn = tk.Frame(self, bg="#160f00", padx=PAD, pady=6)
        _lbl(
            self._warn,
            "⚠   selected channels have different sampling rates"
            " — only channels with the same rate can share one LSL stream",
            fg=WRN, bg="#160f00",
        ).pack(side="left")
        # row 4 is reserved; _warn is shown/hidden via grid / grid_remove

        # row 5 — channel area
        ch_area = tk.Frame(self, bg=BG)
        ch_area.grid(row=5, column=0, sticky="nsew")
        ch_area.grid_columnconfigure(0, weight=1)
        ch_area.grid_rowconfigure(1, weight=1)
        self._build_ch_header(ch_area)
        self._build_ch_scroll(ch_area)

        # row 6 — separator
        _sep(self).grid(row=6, column=0, sticky="ew")

        # row 7 — stream settings + start button
        ctrl = tk.Frame(self, bg=BG2, padx=PAD, pady=PAD)
        ctrl.grid(row=7, column=0, sticky="ew")

        _lbl(ctrl, "STREAM NAME", fg=FGH, bg=BG2).grid(
            row=0, column=0, sticky="w", padx=(0, 6))
        self._name = tk.StringVar(value="LabChart")
        self._name_e = _entry(ctrl, self._name, width=22)
        self._name_e.grid(row=0, column=1, padx=(0, 18))

        _lbl(ctrl, "TYPE", fg=FGH, bg=BG2).grid(
            row=0, column=2, sticky="w", padx=(0, 6))
        self._type = tk.StringVar(value="Phys")
        self._type_e = _entry(ctrl, self._type, width=10)
        self._type_e.grid(row=0, column=3, padx=(0, 18))

        self._start_btn = _btn(ctrl, "START STREAMING", self._on_start)
        self._start_btn.grid(row=0, column=4, sticky="e")
        ctrl.grid_columnconfigure(4, weight=1)

        # row 8 — separator
        _sep(self).grid(row=8, column=0, sticky="ew")

        # row 9 — status bar
        sb = tk.Frame(self, bg=BG, padx=PAD, pady=7)
        sb.grid(row=9, column=0, sticky="ew")
        self._stat_d = tk.Canvas(sb, width=8, height=8, bg=BG, highlightthickness=0)
        self._stat_d.pack(side="left", padx=(0, 6))
        self._stat_l = _lbl(sb, "idle", bg=BG)
        self._stat_l.pack(side="left", padx=(0, 18))
        self._stats = _lbl(sb, bg=BG)
        self._stats.pack(side="left")

    def _build_ch_header(self, parent: tk.Frame):
        hdr = tk.Frame(parent, bg=BG2, pady=5)
        hdr.grid(row=0, column=0, sticky="ew")
        cols = [
            (0, "",          2,  "w", (PAD, 2)),
            (1, "CHANNEL",  16,  "w", (4, 4)),
            (2, "RATE",      8,  "e", (4, 4)),
            (3, "UNIT",      5,  "w", (4, 4)),
            (4, "LSL NAME", 18,  "w", (4, 4)),
            (5, "TYPE",      7,  "w", (4, PAD)),
        ]
        for c, text, width, anchor, padx in cols:
            _lbl(hdr, text, fg=FGH, bg=BG2, anchor=anchor, width=width).grid(
                row=0, column=c, padx=padx, sticky="ew")

    def _build_ch_scroll(self, parent: tk.Frame):
        wrap = tk.Frame(parent, bg=BG)
        wrap.grid(row=1, column=0, sticky="nsew")
        wrap.grid_columnconfigure(0, weight=1)
        wrap.grid_rowconfigure(0, weight=1)

        self._cv = tk.Canvas(wrap, bg=BG, highlightthickness=0)
        sb = tk.Scrollbar(wrap, orient="vertical", command=self._cv.yview,
                          bg=BG2, troughcolor=BG, activebackground=BG3)
        self._cv.configure(yscrollcommand=sb.set)
        sb.grid(row=0, column=1, sticky="ns")
        self._cv.grid(row=0, column=0, sticky="nsew")

        self._ch_frame = tk.Frame(self._cv, bg=BG)
        self._cv_win = self._cv.create_window(
            (0, 0), window=self._ch_frame, anchor="nw")

        self._ch_frame.bind(
            "<Configure>",
            lambda e: self._cv.configure(scrollregion=self._cv.bbox("all")))
        self._cv.bind(
            "<Configure>",
            lambda e: self._cv.itemconfig(self._cv_win, width=e.width))

        self._empty = _lbl(
            self._ch_frame,
            "connect to LabChart to see channels",
            bg=BG, pady=20,
        )
        self._empty.grid(row=0, column=0, columnspan=6, padx=PAD)

    #  State helpers ─

    def _conn_ui(self, state: str):
        """state: 'off' | 'connecting' | 'on'"""
        if state == "off":
            _dot(self._cd, FGA)
            self._cl.config(text="DISCONNECTED", fg=FGA)
            _dot(self._sd, FGA)
            self._sl.config(text="")
            self._conn_btn.config(text="CONNECT", state="normal")
        elif state == "connecting":
            _dot(self._cd, WRN)
            self._cl.config(text="CONNECTING…", fg=WRN)
            self._conn_btn.config(state="disabled")
        elif state == "on":
            _dot(self._cd, ACE)
            self._cl.config(text="CONNECTED", fg=ACE)
            self._conn_btn.config(text="REFRESH", state="normal")

    def _sampling_ui(self, active: bool):
        if active:
            _dot(self._sd, ACE)
            self._sl.config(text="SAMPLING", fg=ACE)
        else:
            _dot(self._sd, FGA)
            self._sl.config(text="NOT SAMPLING", fg=FGA)

    def _stream_ui(self, state: str):
        """state: 'off' | 'on' | 'err'"""
        self._live = (state == "on")
        self._name_e.config(state="disabled" if self._live else "normal")
        self._type_e.config(state="disabled" if self._live else "normal")
        for r in self._rows:
            r.lock(self._live)

        if state == "off":
            _dot(self._stat_d, FGA)
            self._stat_l.config(text="idle", fg=FGA)
            self._start_btn.config(text="START STREAMING", fg=ACE, state="normal")
        elif state == "on":
            _dot(self._stat_d, ACE)
            self._stat_l.config(text="streaming", fg=ACE)
            self._start_btn.config(text="STOP", fg=ERR)
        elif state == "err":
            _dot(self._stat_d, ERR)
            self._stat_l.config(text="error", fg=ERR)
            self._start_btn.config(text="START STREAMING", fg=ACE, state="normal")

    def _show_warn(self, show: bool):
        if show:
            self._warn.grid(row=4, column=0, sticky="ew")
        else:
            self._warn.grid_remove()

    # ── Channel table ─────────────────────────────────────────────────────────

    def _populate(self, ch_info: list):
        for w in self._ch_frame.winfo_children():
            w.destroy()
        self._rows.clear()
        self._show_warn(False)

        if not ch_info:
            _lbl(self._ch_frame, "no channels found", bg=BG, pady=20).grid(
                row=0, column=0, columnspan=6, padx=PAD)
            return

        all_rates = {c["rate"] for c in ch_info}
        multi_rate = len(all_rates) > 1

        for i, ch in enumerate(ch_info):
            row = ChannelRow(
                self._ch_frame, i,
                ch["index"], ch["name"], ch["rate"], ch["unit"],
            )
            row.highlight_rate(multi_rate)
            row.enabled.trace_add("write", lambda *_: self._check_rate_warn())
            self._rows.append(row)

        self._show_warn(multi_rate)

    def _check_rate_warn(self):
        sel = [r for r in self._rows if r.enabled.get()]
        self._show_warn(len({r.rate for r in sel}) > 1)

    # ── Actions ───────────────────────────────────────────────────────────────

    def _on_connect(self):
        if self._live:
            return
        self._conn_ui("connecting")
        threading.Thread(target=self._connect_worker, daemon=True).start()

    def _connect_worker(self):
        try:
            pythoncom.CoInitialize()
            lc = LabChartConnection()
            lc.connect()
            record = lc.current_record
            ch_info = [
                {
                    "index": i,
                    "name":  lc.get_channel_name(i),
                    "rate":  lc.get_channel_rate(i, record),
                    "unit":  lc.get_units(i, record),
                }
                for i in range(1, lc.n_channels + 1)
            ]
            self._q.put({
                "t": "connected", "lc": lc,
                "channels": ch_info, "sampling": lc.is_sampling,
            })
        except Exception as e:
            self._q.put({"t": "conn_err", "msg": str(e)})

    def _on_start(self):
        if self._live:
            self._stop.set()
            self._start_btn.config(state="disabled")
            return

        if self._lc is None:
            return

        sel = [r for r in self._rows if r.enabled.get()]
        if not sel:
            messagebox.showwarning("No channels", "Select at least one channel.")
            return

        rates = {r.rate for r in sel}
        if len(rates) > 1:
            messagebox.showerror(
                "Rate mismatch",
                "Selected channels have different sampling rates.\n\n"
                "All channels in one LSL stream must share the same rate.\n"
                "Deselect the mismatched channels before streaming.",
            )
            return

        cfg = Config(
            stream_name=self._name.get().strip() or "LabChart",
            stream_type=self._type.get().strip() or "Phys",
            channels=[r.to_config() for r in sel],
            status_queue=self._q,
        )
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._stream_worker, args=(cfg,), daemon=True)
        self._thread.start()
        self._stream_ui("on")

    def _stream_worker(self, cfg: Config):
        error = False
        try:
            pythoncom.CoInitialize()
            lc = LabChartConnection()
            lc.connect()
            record = lc.current_record
            outlet = create_lsl_outlet(cfg, lc, record)
            stream_loop(cfg, lc, outlet, stop_event=self._stop)
        except Exception as e:
            error = True
            self._q.put({"t": "stream_err", "msg": str(e)})
        finally:
            self._q.put({"t": "stream_end", "error": error})

    # ── Queue polling ─────────────────────────────────────────────────────────

    def _poll(self):
        try:
            while True:
                self._handle(self._q.get_nowait())
        except queue.Empty:
            pass
        self.after(150, self._poll)

    def _handle(self, msg: dict):
        t = msg["t"]
        if t == "connected":
            self._lc = msg["lc"]
            self._conn_ui("on")
            self._sampling_ui(msg["sampling"])
            self._populate(msg["channels"])
            self._start_btn.config(state="normal")
        elif t == "conn_err":
            self._conn_ui("off")
            messagebox.showerror("Connection failed", msg["msg"])
        elif t == "stats":
            self._sampling_ui(True)
            self._stats.config(
                text=f"{msg['rate']:.0f} Hz  |  ~{msg['latency_ms']:.0f} ms latency",
                fg=FGA,
            )
        elif t == "sampling_stopped":
            self._sampling_ui(False)
        elif t == "stream_end":
            if not msg.get("error"):
                self._stream_ui("off")
                self._stats.config(text="")
        elif t == "stream_err":
            self._stream_ui("err")
            self._stats.config(text=msg["msg"], fg=ERR)


if __name__ == "__main__":
    App().mainloop()
