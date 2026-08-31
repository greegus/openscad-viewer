# Vendored dependencies

## three.js r160 — MIT

`three.module.min.js`, `STLLoader.js`, `OrbitControls.js`, `lines/*`
from https://github.com/mrdoob/three.js (Copyright 2010-2023 three.js authors).

Vendored rather than installed from a package manager on purpose: a Quick Look
extension has no network access and the viewer's CSP blocks remote scripts, so the
library has to ship inside the appex bundle. Keeping it here also means the project
builds with `swiftc` alone — no npm, no bundler, no `node_modules`.

Full licence text: https://github.com/mrdoob/three.js/blob/dev/LICENSE
