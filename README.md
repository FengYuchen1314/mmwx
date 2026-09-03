# MMWX

MMWX is a backend-only repository containing the control plane API, Agent, and
the paired Xray runtime fork. It does not bundle or serve a web frontend.

## Layout

- `controller/` — Go control plane API
- `agent/` — managed server Agent and ShadowTLS sidecar supervisor
- `xray-core/` — paired Xray runtime fork

Every commit pushed to `main` is built and released by GitHub Actions. Release versions
follow `v0.1.<GitHub run number>`; this is a monotonic SemVer patch sequence
without automated source commits or release loops.

The root workflow validates all three components, publishes controller and
Agent images to GHCR, and uploads cross-platform binaries to GitHub Releases.
It intentionally contains no VPS deployment job; published releases never
modify an existing server automatically.

The controller exposes `/healthz` for health checks. Its root path and other
unknown routes return `404`; use the HTTP API or MCP endpoint to manage it.
