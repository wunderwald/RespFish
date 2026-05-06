# webgazer — Gaze Tracking

[app/modules/webgazer/webgazer.js](./modules/webgazer/webgazer.js) is a downloaded copy of the [WebGazer](https://webgazer.cs.brown.edu/) library. It is not maintained here.

`gazeCalibration.js` wraps it with a 9-point calibration + validation flow used optionally by iBreath. `gazetest.js` is a diagnostic frontend for verifying tracking accuracy before a session.

See the [iBreath docs](ibreath.md#ibreath-integration) for how to connect a gaze stream.
