# MMWX

MMWX is a unified repository containing the control plane, Agent, probe, and
the paired Xray runtime fork.

## Layout

- `controller/` — Go control plane and embedded React frontend
- `agent/` — managed server Agent and ShadowTLS sidecar supervisor
- `probe/` — probe service
- `xray-core/` — paired Xray runtime fork

Every commit pushed to `main` is built and released by GitHub Actions. Release versions
follow `v0.1.<GitHub run number>`; this is a monotonic SemVer patch sequence
without automated source commits or release loops.

The root workflow validates all four components, publishes controller and
Agent images to GHCR, uploads cross-platform binaries to GitHub Releases, and
packages the probe Worker. Probe deployment activates automatically after
repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set;
its Worker bindings remain managed in Cloudflare and are preserved by Wrangler.
