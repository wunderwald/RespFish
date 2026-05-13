# RespFish

Electron app for real-time respiration biofeedback experiments.

```
simulation/ ──► LSL ──► lsl_ws_bridge/ ──► WebSocket ──► app/
eyelink_to_lsl/ ──────────────────────────────────────────► app/
```

---

## System Architecture

The experiment runs across two or three machines on the same network.

```
┌─────────────────────────────────────┐      Ethernet
│  PC 1 — Experiment Host             │ ◄──────────────── PC 3 (EyeLink Host)
│  ┌────────────┐  ┌────────────────┐ │
│  │ Screen 1   │  │ Screen 2       │ │
│  │ Exprmtr UI │  │ Experiment     │ │
│  │ (app HUD)  │  │ Display        │ │
│  └────────────┘  │ (EyeLink cam)  │ │
│                  └────────────────┘ │
└────────────────────▲────────────────┘
                     │ LSL (network)
              PC 2 — Physiology
              (resp belt → LabChart
               or mic → simulation/)
```

| Machine | Role | Key software |
|---|---|---|
| **PC 1** | Experiment Host | `app/` (Electron), `lsl_ws_bridge/`, `eyelink_to_lsl/` |
| **PC 2** | Physiological data → LSL | `labchart_to_lsl/` (Windows) or `simulation/` scripts |
| **PC 3** | EyeLink Host | SR Research EyeLink software |

**PC 1 can serve as PC 2** when no dedicated physiology PC is needed (e.g., using `simulation/mic_breath.py`).

Multiple machines can stream data to LSL simultaneously — only the stream selected in the experimenter UI is forwarded to the app.

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
