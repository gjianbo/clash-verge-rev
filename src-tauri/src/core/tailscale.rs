//! Keeps the in-core Tailscale outbound online across configuration reloads.

use crate::core::handle::Handle;
use reqwest::Method;

/// mihomo starts tsnet on first use, so a reload builds a fresh outbound that stays
/// offline until something dials it. One status request is enough to bring it back;
/// when the outbound is absent the core answers 404 and this costs a single round trip.
pub(crate) fn wake() {
    tokio::spawn(async {
        let Ok(request) = Handle::mihomo()
            .load_ctx()
            .build_request(Method::GET, "/tailscale/status")
        else {
            return;
        };
        let _ = request.send().await;
    });
}
