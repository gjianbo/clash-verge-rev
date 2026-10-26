use super::{CmdResult, CommandFailure};
use crate::core::handle::Handle;
use network_interface::{Addr, NetworkInterface, NetworkInterfaceConfig as _};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePeer {
    pub hostname: String,
    pub dns_name: Option<String>,
    pub os: Option<String>,
    pub ips: Vec<String>,
    pub online: bool,
    pub active: bool,
    pub exit_node: bool,
    pub exit_node_option: bool,
    pub relay: Option<String>,
    pub endpoint: Option<String>,
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub available: bool,
    pub backend_state: String,
    pub version: String,
    pub hostname: String,
    pub dns_name: Option<String>,
    pub tailnet: Option<String>,
    pub magic_dns_suffix: Option<String>,
    pub magic_dns_enabled: bool,
    pub auth_url: Option<String>,
    pub ips: Vec<String>,
    pub os: Option<String>,
    pub health: Vec<String>,
    #[serde(rename = "self")]
    pub self_node: Option<TailscalePeer>,
    pub peers: Vec<TailscalePeer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TailscalePing {
    pub ip: String,
    pub node_ip: Option<String>,
    pub node_name: Option<String>,
    pub latency_seconds: f64,
    pub endpoint: Option<String>,
    pub relay: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleConflict {
    pub conflict: bool,
    pub interfaces: Vec<String>,
}

const MIHOMO_TUN_DEVICES: &[&str] = &["utun1024", "Mihomo"];
const TAILSCALE_API_UNAVAILABLE: &str = "Tailscale outbound is not loaded";

fn api_failure(error: impl std::fmt::Display) -> CommandFailure {
    CommandFailure::plain(format!("Tailscale API request failed: {error}"))
}

fn decode<T: serde::de::DeserializeOwned>(status: reqwest::StatusCode, body: &str) -> CmdResult<T> {
    if status == reqwest::StatusCode::NOT_FOUND {
        if body.contains(TAILSCALE_API_UNAVAILABLE) {
            return Err(CommandFailure::coded(
                "tailscale_not_configured",
                "Tailscale is enabled but the running core has no Tailscale outbound yet; save the settings and restart the core",
            ));
        }
        // The route itself is missing: the core predates the status patch.
        return Err(CommandFailure::coded(
            "tailscale_core_unsupported",
            "The running core does not expose the Tailscale status API",
        ));
    }
    if status == reqwest::StatusCode::NOT_IMPLEMENTED {
        return Err(CommandFailure::coded(
            "tailscale_core_unsupported",
            "The running core was built without the Tailscale status API",
        ));
    }
    if !status.is_success() {
        return Err(CommandFailure::plain(format!(
            "Tailscale API returned {status}: {body}"
        )));
    }
    serde_json::from_str(body)
        .map_err(|error| CommandFailure::plain(format!("Invalid Tailscale API payload: {error}: {body}")))
}

#[tauri::command]
#[specta::specta]
pub async fn get_tailscale_status() -> CmdResult<TailscaleStatus> {
    let request = {
        let context = Handle::mihomo().load_ctx();
        context
            .build_request(reqwest::Method::GET, "/tailscale/status")
            .map_err(api_failure)?
    };
    let response = request.send().await.map_err(api_failure)?;
    let status = response.status();
    let body = response.text().await.map_err(api_failure)?;
    decode(status, &body)
}

#[tauri::command]
#[specta::specta]
pub async fn ping_tailscale_peer(ip: std::string::String) -> CmdResult<TailscalePing> {
    let request = {
        let context = Handle::mihomo().load_ctx();
        context
            .build_request(reqwest::Method::POST, "/tailscale/ping")
            .map_err(api_failure)?
            .json(&serde_json::json!({ "ip": ip }))
    };
    let response = request.send().await.map_err(api_failure)?;
    let status = response.status();
    let body = response.text().await.map_err(api_failure)?;
    decode(status, &body)
}

/// Detects an official Tailscale client that still owns a tailnet address, which would fight
/// mihomo for the 100.64.0.0/10 route and MagicDNS.
#[tauri::command]
#[specta::specta]
pub async fn get_tailscale_conflict() -> CmdResult<TailscaleConflict> {
    let interfaces = tokio::task::spawn_blocking(NetworkInterface::show)
        .await
        .map_err(api_failure)?
        .map_err(api_failure)?;

    let mut conflicts = Vec::new();
    for interface in interfaces {
        if MIHOMO_TUN_DEVICES.contains(&interface.name.as_str()) {
            continue;
        }
        let owns_tailnet = interface.addr.iter().any(|addr| match addr {
            Addr::V4(addr) => is_tailnet_v4(addr.ip),
            Addr::V6(addr) => is_tailnet_v6(addr.ip),
        });
        if owns_tailnet {
            conflicts.push(interface.name);
        }
    }
    Ok(TailscaleConflict {
        conflict: !conflicts.is_empty(),
        interfaces: conflicts,
    })
}

fn is_tailnet_v4(ip: std::net::Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}

const fn is_tailnet_v6(ip: std::net::Ipv6Addr) -> bool {
    let segments = ip.segments();
    segments[0] == 0xfd7a && segments[1] == 0x115c && segments[2] == 0xa1e0
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_status_payload_with_empty_collections() {
        let body = r#"{"available":true,"backendState":"NeedsLogin","version":"1.0","hostname":"node","magicDnsEnabled":false,"ips":[],"health":[],"peers":[]}"#;
        let status: TailscaleStatus = decode(reqwest::StatusCode::OK, body).expect("status payload");
        assert!(status.health.is_empty());
        assert!(status.peers.is_empty());
    }

    #[test]
    fn classifies_a_missing_route_as_an_unsupported_core() {
        let error =
            decode::<TailscaleStatus>(reqwest::StatusCode::NOT_FOUND, "404 page not found").expect_err("missing route");
        assert_eq!(error.code.as_deref(), Some("tailscale_core_unsupported"));
    }

    #[test]
    fn classifies_an_unloaded_outbound() {
        let error = decode::<TailscaleStatus>(
            reqwest::StatusCode::NOT_FOUND,
            r#"{"message":"Tailscale outbound is not loaded"}"#,
        )
        .expect_err("missing outbound");
        assert_eq!(error.code.as_deref(), Some("tailscale_not_configured"));
    }
}
