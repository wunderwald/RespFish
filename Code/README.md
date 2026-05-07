# RespFish

Electron app for real-time respiration biofeedback experiments.

```
resp/ → LSL → lsl_bridge/ → WebSocket → app/
```

## Folders

| Folder | Contents |
|---|---|
| [app/](app/) | Electron experiment app — frontends, modules, docs |
| [resp/](resp/) | Python scripts for LSL signal sources (mic, simulation, mouse) |
| [lsl_bridge/](lsl_bridge/) | Bridges an LSL stream to the app over WebSocket |
| [gaze/](gaze/) | Gaze simulation script |
| [raspi/](raspi/) | Raspberry Pi analog-to-LSL script |
| [labchart_to_lsl/](labchart_to_lsl/) | Windows-only LabChart → LSL forwarding module |
