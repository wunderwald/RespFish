"""
eyelink_to_lsl.py
=================
Reads gaze samples from an EyeLink tracker via pylink and publishes them
as normalised [0.0, 1.0] screen coordinates on an LSL outlet.

LSL stream spec
---------------
  Name     : "GazeXY"
  Type     : "Gaze"
  Channels : 2  ->  [x_norm, y_norm]
               x: 0.0 = left edge,  1.0 = right edge
               y: 0.0 = top edge,   1.0 = bottom edge
  Format   : float32
  Rate     : nominal 500 Hz (matches tracker sample_rate command)

Missing / blink samples are pushed as [-1.0, -1.0].

Calibration
-----------
Calibration visuals are drawn on the experiment display via
PsychopyCalibrationDisplay (or any CalibrationDisplay you provide).
Pass the PsychoPy window to the bridge at construction time.
Trigger recalibration at any point via bridge.request_calibrate().

Usage
-----
    from psychopy import visual
    from eyelink_to_lsl import EyeLinkLSLBridge

    win = visual.Window(size=(1920, 1080), screen=1, fullscr=True, units="pix")

    bridge = EyeLinkLSLBridge(
        host_ip="100.1.1.1",
        screen_w=1920,
        screen_h=1080,
        window=win,
    )
    bridge.connect()
    bridge.calibrate()      # run initial calibration before experiment
    bridge.start()          # begin recording + LSL stream (non-blocking)

    # ...run your experiment...
    # from any thread / WS handler:
    bridge.request_calibrate()

    bridge.stop()
    bridge.disconnect()

Dependencies
------------
    pylink   -- SR Research EyeLink Developer Kit (not the PyPI pylink package)
    pylsl    -- pip install pylsl
    psychopy -- pip install psychopy  (only needed for PsychopyCalibrationDisplay)
"""

import logging
import threading
import time
from typing import Protocol, runtime_checkable

import pylink
from pylsl import StreamInfo, StreamOutlet, local_clock

log = logging.getLogger(__name__)

MISSING_VAL: float = -1.0
NOMINAL_RATE: float = 500.0


# ---------------------------------------------------------------------------
# Calibration display protocol
# ---------------------------------------------------------------------------

@runtime_checkable
class CalibrationDisplay(Protocol):
    """
    Minimal interface the bridge needs from a calibration display.
    Implement this to use a renderer other than PsychoPy.
    """
    def setup(self, tracker: pylink.EyeLink) -> None: ...
    def teardown(self) -> None: ...


# ---------------------------------------------------------------------------
# PsychoPy calibration display
# ---------------------------------------------------------------------------

class PsychopyCalibrationDisplay(pylink.EyeLinkCustomDisplay):
    """
    Draws EyeLink calibration/validation targets on a PsychoPy window.

    pylink calls the draw_* methods on the Host PC's schedule.  We keep
    it deliberately minimal: a filled circle target with a small centre dot.
    Extend draw_line / play_beep etc. as needed for your setup.
    """

    TARGET_OUTER_RADIUS = 20    # px
    TARGET_INNER_RADIUS = 4     # px
    TARGET_COLOR_OUTER  = "white"
    TARGET_COLOR_INNER  = "black"
    BG_COLOR            = "grey"

    def __init__(self, window):
        super().__init__()
        self._win = window
        self._w, self._h = window.size  # pixel dimensions

        # Import here so the rest of the module works without PsychoPy.
        from psychopy import visual, event
        self._event = event

        self._outer = visual.Circle(
            window, radius=self.TARGET_OUTER_RADIUS,
            fillColor=self.TARGET_COLOR_OUTER,
            lineColor=self.TARGET_COLOR_OUTER,
            units="pix",
        )
        self._inner = visual.Circle(
            window, radius=self.TARGET_INNER_RADIUS,
            fillColor=self.TARGET_COLOR_INNER,
            lineColor=self.TARGET_COLOR_INNER,
            units="pix",
        )

    # -- Required pylink.EyeLinkCustomDisplay callbacks --------------------

    def setup_cal_display(self):
        self._win.setColor(self.BG_COLOR)
        self._win.flip()

    def clear_cal_display(self):
        self._win.setColor(self.BG_COLOR)
        self._win.flip()

    def exit_cal_display(self):
        self._win.setColor(self.BG_COLOR)
        self._win.flip()

    def draw_cal_target(self, x, y):
        """Draw calibration target at tracker pixel coords (x, y)."""
        pos = self._tracker_to_psychopy(x, y)
        self._outer.pos = pos
        self._inner.pos = pos
        self._win.setColor(self.BG_COLOR)
        self._outer.draw()
        self._inner.draw()
        self._win.flip()

    def erase_cal_target(self):
        self._win.setColor(self.BG_COLOR)
        self._win.flip()

    def draw_line(self, x1, y1, x2, y2, colorindex):
        # Optional: draw gaze-contingent lines during validation.
        pass

    def play_beep(self, beep_id):
        # Optional: audio feedback during calibration.
        pass

    def get_input_key(self):
        """
        Forward keyboard input to the EyeLink Host during calibration.
        Returns a list of pylink.KeyInput objects, or an empty list.
        """
        keys = self._event.getKeys(keyList=None, modifiers=False)
        mapped = []
        for k in keys:
            keycode = self._key_to_eyelink(k)
            if keycode is not None:
                mapped.append(pylink.KeyInput(keycode, 0))
        return mapped

    def setup(self, tracker: pylink.EyeLink) -> None:
        tracker.openGraphicsEx(self)

    def teardown(self) -> None:
        pylink.closeGraphics()

    # -- Helpers -----------------------------------------------------------

    def _tracker_to_psychopy(self, x, y):
        """
        Convert EyeLink pixel coords (origin top-left) to PsychoPy pix coords
        (origin centre, y-axis flipped).
        """
        px = x - self._w / 2.0
        py = self._h / 2.0 - y
        return (px, py)

    def _key_to_eyelink(self, key: str):
        """Map PsychoPy key name to an EyeLink key code."""
        _MAP = {
            "return": pylink.ENTER_KEY,
            "escape": pylink.ESC_KEY,
            "up":     pylink.CURS_UP,
            "down":   pylink.CURS_DOWN,
            "left":   pylink.CURS_LEFT,
            "right":  pylink.CURS_RIGHT,
            "space":  ord(" "),
            "a":      ord("a"),
            "c":      ord("c"),
            "v":      ord("v"),
            "o":      ord("o"),
        }
        return _MAP.get(key)


# ---------------------------------------------------------------------------
# Bridge
# ---------------------------------------------------------------------------

class EyeLinkLSLBridge:
    """
    Connects to an EyeLink Host, streams gaze as normalised LSL samples,
    and supports operator-initiated recalibration mid-experiment.

    Parameters
    ----------
    host_ip : str
        IP address of the EyeLink Host PC (default link is 100.1.1.1).
    screen_w, screen_h : int
        Pixel dimensions of the experiment display (Screen 2).
    window : PsychoPy Window
        The experiment display window used to draw calibration targets.
        Ignored if you supply a custom `display`.
    sample_rate : float
        Tracker sample rate in Hz. Must match the tracker's configuration.
    edf_filename : str
        Base name of the EDF file recorded on the Host PC (max 8 chars).
    display : CalibrationDisplay, optional
        Custom calibration display. If omitted, PsychopyCalibrationDisplay
        is constructed automatically from `window`.
    """

    def __init__(
        self,
        host_ip: str,
        screen_w: int,
        screen_h: int,
        window=None,
        sample_rate: float = NOMINAL_RATE,
        edf_filename: str = "session",
        display: CalibrationDisplay | None = None,
    ):
        self.host_ip = host_ip
        self.screen_w = screen_w
        self.screen_h = screen_h
        self.sample_rate = sample_rate
        self.edf_filename = edf_filename[:8]  # EyeLink 8-char limit

        if display is not None:
            self._display = display
        elif window is not None:
            self._display = PsychopyCalibrationDisplay(window)
        else:
            raise ValueError("Provide either `window` or a custom `display`.")

        self._tracker: pylink.EyeLink | None = None
        self._outlet: StreamOutlet | None = None
        self._thread: threading.Thread | None = None
        self._running = False
        self._eye = pylink.RIGHT_EYE  # updated after connect()

        # Set by request_calibrate(); consumed inside the pump loop.
        self._calib_requested = threading.Event()

    # ------------------------------------------------------------------ #
    #  Public API                                                          #
    # ------------------------------------------------------------------ #

    def connect(self) -> None:
        """Open connection to the EyeLink Host and configure the tracker."""
        log.info("Connecting to EyeLink Host at %s", self.host_ip)
        self._tracker = pylink.EyeLink(self.host_ip)
        self._tracker.openDataFile(self.edf_filename + ".edf")

        self._tracker.sendCommand(
            f"screen_pixel_coords = 0 0 {self.screen_w - 1} {self.screen_h - 1}"
        )
        self._tracker.sendMessage(
            f"DISPLAY_COORDS 0 0 {self.screen_w - 1} {self.screen_h - 1}"
        )
        self._tracker.sendCommand(f"sample_rate {int(self.sample_rate)}")
        self._tracker.sendCommand("recording_parse_type = GAZE")

        eye = self._tracker.eyeAvailable()
        self._eye = eye
        self._tracker.sendCommand(
            f"binocular_enabled = {'YES' if eye == pylink.BINOCULAR else 'NO'}"
        )

        # Register custom display with pylink before any calibration call.
        self._display.setup(self._tracker)
        self._setup_lsl_outlet()
        log.info("Connected. Eye(s) available: %s", eye)

    def calibrate(self) -> None:
        """
        Run a full calibration + validation sequence (blocking).
        Call once before start(), or let request_calibrate() call it
        mid-experiment from the pump thread.
        The experiment display will show calibration targets.
        """
        log.info("Starting calibration ...")
        self._tracker.doTrackerSetup()
        log.info("Calibration complete.")

    def request_calibrate(self) -> None:
        """
        Signal the pump thread to pause recording and run calibration.
        Returns immediately; calibration runs asynchronously in the pump
        thread so that all display and tracker calls stay on one thread.
        """
        log.info("Calibration requested.")
        self._calib_requested.set()

    def start(self) -> None:
        """Start EyeLink recording and launch the background LSL pump thread."""
        if self._running:
            log.warning("Bridge is already running.")
            return
        self._start_recording()
        self._running = True
        self._thread = threading.Thread(
            target=self._pump, name="EyeLinkLSLPump", daemon=True
        )
        self._thread.start()
        log.info("EyeLink -> LSL pump started.")

    def stop(self) -> None:
        """Stop the pump thread and end EyeLink recording."""
        self._running = False
        self._calib_requested.clear()
        if self._thread:
            self._thread.join(timeout=2.0)
        pylink.endRealTimeMode()
        self._tracker.stopRecording()
        log.info("EyeLink -> LSL pump stopped.")

    def disconnect(self) -> None:
        """Transfer the EDF file to PC 1, close the tracker, tear down graphics."""
        if self._tracker:
            self._tracker.setOfflineMode()
            pylink.msecDelay(500)
            self._tracker.closeDataFile()

            local_edf = self.edf_filename + ".edf"
            log.info("Transferring EDF -> %s ...", local_edf)
            self._tracker.receiveDataFile(self.edf_filename + ".edf", local_edf)

            self._tracker.close()
            self._tracker = None

        self._display.teardown()
        log.info("EyeLink disconnected.")

    # ------------------------------------------------------------------ #
    #  Internal                                                            #
    # ------------------------------------------------------------------ #

    def _start_recording(self) -> None:
        # startRecording(samples_to_file, events_to_file,
        #                samples_over_link, events_over_link)
        self._tracker.startRecording(1, 1, 1, 1)
        time.sleep(0.1)             # let the tracker spin up
        pylink.beginRealTimeMode(100)

    def _pump(self) -> None:
        """Tight loop: pull latest sample, push to LSL, service recalibration."""
        while self._running:

            if self._calib_requested.is_set():
                self._calib_requested.clear()
                self._do_recalibrate()

            sample = self._tracker.getNewestSample()
            if sample is None:
                continue

            x, y = self._extract_gaze(sample)
            self._outlet.push_sample([x, y], local_clock())

    def _do_recalibrate(self) -> None:
        """Pause recording, run calibration on the experiment display, resume."""
        log.info("Pausing recording for recalibration ...")
        pylink.endRealTimeMode()
        self._tracker.stopRecording()

        self.calibrate()            # blocks until operator accepts on Host PC

        self._start_recording()
        log.info("Recording resumed after recalibration.")

    def _setup_lsl_outlet(self) -> None:
        info = StreamInfo(
            name="GazeXY",
            type="Gaze",
            channel_count=2,
            nominal_srate=self.sample_rate,
            channel_format="float32",
            source_id=f"EyeLink@{self.host_ip}",
        )
        chns = info.desc().append_child("channels")
        for label in ("x_norm", "y_norm"):
            ch = chns.append_child("channel")
            ch.append_child_value("label", label)
            ch.append_child_value("unit", "normalized_screen")
            ch.append_child_value("type", "Gaze")

        self._outlet = StreamOutlet(info)
        log.info("LSL outlet 'GazeXY' created.")

    def _extract_gaze(self, sample) -> tuple[float, float]:
        """
        Return normalised (x, y) from a pylink sample.

        Binocular: averages both eyes, falls back to whichever is valid.
        Monocular: uses the tracked eye directly.
        """
        if self._eye == pylink.BINOCULAR:
            lx, ly = sample.getLeftEye().getGaze()
            rx, ry = sample.getRightEye().getGaze()
            l_ok = lx != pylink.MISSING_DATA
            r_ok = rx != pylink.MISSING_DATA

            if l_ok and r_ok:
                px, py = (lx + rx) / 2.0, (ly + ry) / 2.0
            elif l_ok:
                px, py = lx, ly
            elif r_ok:
                px, py = rx, ry
            else:
                return MISSING_VAL, MISSING_VAL
        else:
            eye_data = (
                sample.getLeftEye()
                if self._eye == pylink.LEFT_EYE
                else sample.getRightEye()
            )
            px, py = eye_data.getGaze()
            if px == pylink.MISSING_DATA:
                return MISSING_VAL, MISSING_VAL

        return px / self.screen_w, py / self.screen_h
