# Deployment assets

Production deployments should terminate TLS and authenticate every `/mcp` request.
The server binds to loopback by default and refuses unauthenticated non-loopback
startup. See [deployment.md](../docs/deployment.md) for Docker, Kubernetes, reverse
proxy, OIDC, secret rotation, scaling, and rollback procedures.

- `systemd/newrelic-mcp.service` is a hardened unit for a package installed under
  `/opt/newrelic-mcp`. Start from `systemd/environment.example`, put non-secret
  settings in `/etc/newrelic-mcp/environment`, and
  mount credentials as root-owned `0400` files referenced by `*_FILE` settings.
  The unit intentionally does not enable `MemoryDenyWriteExecute`, which conflicts
  with the V8 JIT on common Node.js builds; use a separately tested `--jitless`
  deployment before adding that restriction.
- `nginx/newrelic-mcp.conf` is a same-host TLS reverse-proxy example that exposes
  only `/mcp` and RFC 9728 discovery. Disable the discovery location in bearer mode
  if it is not needed.
- `../docker-compose.yml` is a single-node example with read-only filesystem,
  dropped capabilities, mounted secrets, and loopback-only host publishing.
- `../helm/newrelic-mcp` is the production Kubernetes chart.

The systemd unit deliberately listens on `127.0.0.1`. Put a TLS reverse proxy on
the same host, forward only `/mcp`, and configure an explicit Host and Origin
allowlist. Health endpoints may be exposed only to the local supervisor.
