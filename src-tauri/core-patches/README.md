# Tailscale core patches

Upstream mihomo already ships the `type: tailscale` outbound (tsnet, userspace) since
v1.19.30, but it does not expose the tsnet status to clients. Verge's Tailscale status page
needs that data, so this directory carries the smallest patch that adds it.

## What `0001-tailscale-status-api.patch` adds

| File | Change |
| --- | --- |
| `adapter/outbound/tailscale.go` | Instance registry, `LookupTailscale()`, `Status()` and `Ping()` |
| `hub/route/tailscale.go` | `GET /tailscale/status` and `POST /tailscale/ping` |
| `hub/route/tailscale_stub.go` | Same routes returning 501 when built without gvisor |
| `hub/route/server.go` | Mounts `/tailscale` on the external controller |

The status endpoint returns a stable Verge-shaped payload (camelCase), not raw tsnet JSON,
so the frontend does not depend on Tailscale internals.

## Build a patched core

`src-tauri/core-release.json` pins the upstream repo, tag and patch list.

```bash
# Build for this machine and place it at src-tauri/sidecar/verge-mihomo-<triple>
node scripts/build-core.mjs

# Build a release asset for a specific target (dist/core/<asset>-<version>.gz|.zip)
node scripts/build-core.mjs --package --target aarch64-apple-darwin
```

`scripts/prebuild.mjs` keeps an existing sidecar unless `--force` is passed, so a locally
built core survives `pnpm prebuild`.

Service mode runs an administrator-approved copy of the core. After rebuilding the sidecar,
reinstall or repair the Clash Verge service so it stages the new binary; otherwise TUN keeps
running the previously approved core while status reports the old API.

## Publish a fork

1. Fork `MetaCubeX/mihomo` (the pinned tag is in `core-release.json`).
2. Apply the patch on top of that tag.
3. Build all targets with `CGO_ENABLED=0` and `-tags with_gvisor`; do **not** set
   `no_tailscale`. Set `-X github.com/metacubex/mihomo/constant.Version=<version>`.
4. Upload the assets with the exact names used by `scripts/prebuild.mjs`
   (`mihomo-darwin-arm64-go122`, `mihomo-windows-amd64-v2`, ...) plus `version.txt`,
   which must contain the same version string. If you keep bundling the alpha core,
   publish a `Prerelease-Alpha` release in the fork as well.
5. Point `releaseRepo` in `src-tauri/core-release.json` at the fork.

`feat/core_upgrade.rs` reads the same file, so in-app upgrades follow the fork too. A core
without this patch still works for routing; only the status page reports that the status
API is unavailable.

## Updating upstream

Bump `buildVersion`, run `node scripts/build-core.mjs`, and re-export the patch if it no
longer applies:

```bash
git -C node_modules/.verge/mihomo-src add -A
git -C node_modules/.verge/mihomo-src diff --cached > src-tauri/core-patches/0001-tailscale-status-api.patch
```
