# VPS deployment

This directory is the immutable bootstrap configuration for the production
controller on `185.99.135.224`.

- `compose.yaml` exposes the controller only on `127.0.0.1:12889` and retains
  `data`, `subscribes`, and `rule_templates` in `/opt/mmwx`.
- `nginx.conf` redirects HTTP to HTTPS and accepts Cloudflare's Full-mode
  origin connection with a locally generated self-signed certificate. It
  passes the original panel hostname to the controller.
- `deploy.sh` is deliberately limited to `docker compose pull/up` for the
  controller, so a GitHub Actions deployment cannot delete configuration data.

The Cloudflare zone must use **Full**, not Flexible or Full (strict), for the
locally generated self-signed origin certificate. No public certificate is
requested by this deployment.
