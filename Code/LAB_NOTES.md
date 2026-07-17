# RespFish - Lab Notes

by Moritz Wunderwald, last updated 11.06.2026

## Lab computer network

The network currently consists of three computers that are connected through a local network:

1. Presentation PC (left, aka Video computer)
2. EEG PC (middle)
3. EyeLink PC (right)

The **EEG PC** is the **central data hub**. It records all data sent through LSL using LabRecorder, records physiological data (respiration, ECG) in ADI LabChart and forwards them to LSL. The **presentation PC** runs the experiment logic and renders stimuli. It **receives physiological and gaze data** and **sends out marker data**. Marker, physiological and gaze data as well as experiment metadata is recorded on the presentation computer as well but for further analysis, the data collected by the EEG PC is meant to be used.

The lab computers are assigned **static IP addresses (192.168.10.XX)** and the **subnet mask 255.255.255.0**. Manual IP assignment is not required by the LSL standard but in practice seems to increase reliability.

The lab computers **can be connected to the local network and the univie domain network (the internet) at the same time**.

## LSL and the univie network policies

The LSL protocol is a combination of **UDP** (stream discovery broadcasts) and **TCP** (stateful connections for data streaming). By default, especially UDP broadcast are forbidden by the univie network policies (firewall). Our lab computers have special rights to freely use UDP and TCP on the ports that the LSL protocol uses. 

This means that no firewall changes need to be done to get LSL running.

...

**BUT**

...

Our special networking rights are **only for public (and private) networks, NOT for domain-profile networks**. The univie LAN is domain level and the network adpter connected to univie LAN can not be set to public.  

For us this means: **we can ONLY communicate with LSL through network adapters (ethernet dongles) that are not used to connect to the univie network**. Such are set to public by default and work for LSL without extra config.

## Running the experiments

The basic steps for running RespFish experiments:

1. Physiological data acquisition: Start ADI hardware and LabChart (on EEG PC), press Start in LabChart.
2. Physiological data streaming: On the EEG PC, open LabChartLSL, click connect, select the channels to be streamed, give them a name, start streaming.
3. Presentation setup: On the presentation PC, open RespFish, select the experiment, set parameters like SubjectID,  select the physiological data stream. Don't press start yet.
4. *Optionally connect eye tracker*: make sure the EyeLink PC is on and connected to the network. Start the EyeLink to LSL bridge using the batch script. The bridge passes control messages received via ws to the tracker device and forwards gaze samples to lsl (which are then forwarded to ws by the lsl_to_ws bridge). Select the gaze stream in the experimenter control.
5. Recording: Open LabRecorder on the EEG PC and select the streams to be recorded (physiological data, markers and in future gaze). Set output paths and hit the Start button.
6. Run experiment: Click start on the presentation PC.