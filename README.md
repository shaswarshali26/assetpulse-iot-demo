# AssetPulse IoT tracking demo

A browser-only simulation of an IoT asset-tracking platform for non-powered assets moving between 41 geozones in 10 cities across Iraq (Duhok, Erbil, Mosul, Kirkuk, Sulaymaniyah, Baghdad, Ramadi, Karbala, Najaf, Basra), with a city filter across every view. Built by iQ Labs.

Live: https://assetpulse-iot-demo.netlify.app

## Features
- Live map with tracker-realistic reporting (GNSS trackers, BLE tags heard only at gateways, condition sensors)
- Assets table, geozone inventory and visits, alerts with acknowledge/resolve
- Analytics: stock evolution, utilization, dwell and cycle time, battery distribution
- Simulator: speed control and injectable scenarios (unauthorized movement, temperature excursion, forgotten asset, battery drain, stock shortage)

## Structure
- `site/index.html` – landing page
- `site/app.html`, `site/js/app.js`, `site/css/app.css` – platform UI
- `site/js/sim.js` – simulation engine
- `netlify.toml` – publishes the `site` folder

## Run locally
```bash
python3 -m http.server 8788 -d site
```
