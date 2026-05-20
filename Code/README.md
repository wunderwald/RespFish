# RespFish

Electron app for real-time respiration biofeedback experiments.

---

## System Architecture

The experiment runs across two or three machines on the same network.

| Machine | Role | Key software |
|---|---|---|
| **PC 1** | Experiment Host | `app/` (Electron), `lsl_ws_bridge/`, `eyelink_to_lsl/` |
| **PC 2** | Physiological data → LSL | `labchart_to_lsl/` (Windows) or `simulation/` scripts |
| **PC 3** | EyeLink Host | SR Research EyeLink software |

**PC 1 can serve as PC 2**.

Multiple machines can stream data to LSL simultaneously. Only the stream selected in the experimenter UI is forwarded to the app.

---

## Folders

| Folder | Contents |
|---|---|
| [app/](app/) | Electron experiment app — frontends, modules, docs |
| [lsl_ws_bridge/](lsl_ws_bridge/) | Bridges LSL streams to the app over WebSocket |
| [simulation/](simulation/) | LSL signal sources for testing: simulated resp, simulated gaze, mic, mouse |
| [eyelink_to_lsl/](eyelink_to_lsl/) | SR Research EyeLink → LSL bridge |
| [labchart_to_lsl/](labchart_to_lsl/) | Windows-only LabChart → LSL forwarding module |
| [raspi/](raspi/) | Raspberry Pi analog-to-LSL script |
