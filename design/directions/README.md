# Design directions

Three directions for the revamp of the web app and the landing page, as static mockups. Nothing here is
wired into `web/`; the owner picks a direction first. `SPEC.md` is the shared brief every direction was
built from (the same data, the same four composer controls, the same rules for menus and sheets).

Start with **`compare.png`** (or `compare.html`): the three composers side by side, desktop close-up with
a picker open, then the phone and its bottom sheet.

| | Helm | Chart | Night Watch |
|---|---|---|---|
| idea | the instrument panel | the route on the chart | the lit binnacle |
| primary theme | dark | light | dark |
| type | Geist + Geist Mono | Schibsted Grotesk + Fragment Mono | Mona Sans (wide display) + JetBrains Mono |
| accent | brass-lime `#CFDB6E` | buoy orange `#E4572E` | lamp amber `#F2B544` |
| composer | toolbar of pills inside the box | a route sentence, each word a picker | a manifest of four labelled cells + preflight line |
| picker shown open | agent + model, effort submenu | where + sandbox submenu | repository filter + branch submenu |
| landing section | Steer it mid-turn | Factory as a route | Where it runs |

Each folder has `home.html` (`?state=open`), `home-phone.html` (`?state=sheet`), `session.html` and
`landing.html` (responsive), all taking `?theme=light|dark`, and their renders in `shots/`.

Re-render a page with `./shoot.sh <page.html> <out.png> <width> <height> "<query>" [--full]`
(headless Chromium through agent-browser).
