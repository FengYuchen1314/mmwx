# MMWX

MMWX is a unified repository containing the control plane, Agent, probe, and
the paired Xray runtime fork.

## Layout

- `controller/` — Go control plane and embedded React frontend
- `agent/` — managed server Agent and ShadowTLS sidecar supervisor
- `probe/` — probe service
- `xray-core/` — paired Xray runtime fork

Every push to `main` is built and released by GitHub Actions. Release versions
follow `v0.1.<GitHub run number>`; this is a monotonic SemVer patch sequence
without automated source commits or release loops.
