# VPS deployment

This directory is the immutable bootstrap configuration for the production
controller on `185.99.135.224`.

- `compose.yaml` exposes the controller only on `127.0.0.1:12889` and retains
  `data`, `subscribes`, and `rule_templates` in `/opt/mmwx`.
- `nginx.conf` accepts the Cloudflare origin connection over HTTP and passes
  the original panel hostname to the controller.
- `deploy.sh` is deliberately limited to `docker compose pull/up` for the
  controller, so a GitHub Actions deployment cannot delete configuration data.

For Cloudflare Flexible SSL, enable **Always Use HTTPS** at the Cloudflare edge.
Do not install an HTTP-to-HTTPS redirect at the origin, because it causes a
redirect loop when Cloudflare connects to the origin over HTTP.
