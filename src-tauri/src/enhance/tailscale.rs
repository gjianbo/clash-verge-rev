use crate::config::IVergeTailscale;
use clash_verge_logging::{Type, logging};
use serde_yaml_ng::{Mapping, Value};

const DEFAULT_NAME: &str = "TS";
const DEFAULT_HOSTNAME: &str = "clash-verge";
const DEFAULT_STATE_DIR: &str = "tailscale";
const DOMAIN_SUFFIX: &str = "ts.net";
const CGNAT_V4: &str = "100.64.0.0/10";
const CGNAT_V6: &str = "fd7a:115c:a1e0::/48";

fn text<'a>(value: Option<&'a str>, fallback: &'a str) -> &'a str {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
}

fn has_proxy_or_group(config: &Mapping, name: &str) -> bool {
    ["proxies", "proxy-groups"].iter().any(|section| {
        config.get(*section).and_then(Value::as_sequence).is_some_and(|items| {
            items
                .iter()
                .any(|item| item.get("name").and_then(Value::as_str) == Some(name))
        })
    })
}

fn is_valid_cidr(raw: &str) -> bool {
    let Some((address, prefix)) = raw.split_once('/') else {
        return false;
    };
    let Ok(address) = address.parse::<std::net::IpAddr>() else {
        return false;
    };
    let Ok(prefix) = prefix.parse::<u8>() else {
        return false;
    };
    prefix <= if address.is_ipv4() { 32 } else { 128 }
}

/// Appends the Tailscale outbound, prepends its routing rules and points MagicDNS at it.
///
/// Runs after every profile override so a subscription cannot remove tailnet reachability.
pub fn use_tailscale(mut config: Mapping, settings: Option<&IVergeTailscale>) -> Mapping {
    let Some(settings) = settings else {
        return config;
    };
    if !settings.enable.unwrap_or(false) {
        return config;
    }
    let Some(auth_key) = settings
        .auth_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    else {
        logging!(
            warn,
            Type::Config,
            "Tailscale is enabled without an auth key; skipping outbound injection"
        );
        return config;
    };
    let name = text(settings.name.as_deref(), DEFAULT_NAME);
    if has_proxy_or_group(&config, name) {
        logging!(
            warn,
            Type::Config,
            "Tailscale injection skipped: a proxy or group named {name:?} already exists"
        );
        return config;
    }

    let mut proxy = Mapping::new();
    proxy.insert(Value::from("name"), Value::from(name));
    proxy.insert(Value::from("type"), Value::from("tailscale"));
    proxy.insert(
        Value::from("hostname"),
        Value::from(text(settings.hostname.as_deref(), DEFAULT_HOSTNAME)),
    );
    proxy.insert(Value::from("auth-key"), Value::from(auth_key));
    proxy.insert(
        Value::from("state-dir"),
        Value::from(text(settings.state_dir.as_deref(), DEFAULT_STATE_DIR)),
    );
    proxy.insert(Value::from("udp"), Value::from(settings.udp.unwrap_or(true)));
    if let Some(accept_routes) = settings.accept_routes {
        proxy.insert(Value::from("accept-routes"), Value::from(accept_routes));
    }
    if let Some(dialer_proxy) = settings
        .dialer_proxy
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        proxy.insert(Value::from("dialer-proxy"), Value::from(dialer_proxy));
    }
    if let Some(exit_node) = settings
        .exit_node
        .as_deref()
        .map(str::trim)
        .filter(|node| !node.is_empty())
    {
        proxy.insert(Value::from("exit-node"), Value::from(exit_node));
    }

    let mut proxies = config
        .remove(Value::from("proxies"))
        .and_then(|value| value.as_sequence().cloned())
        .unwrap_or_default();
    proxies.push(Value::Mapping(proxy));
    config.insert(Value::from("proxies"), Value::Sequence(proxies));

    let mut rules = vec![
        Value::from(format!("DOMAIN-SUFFIX,{DOMAIN_SUFFIX},{name}")),
        Value::from(format!("IP-CIDR,{CGNAT_V4},{name},no-resolve")),
        Value::from(format!("IP-CIDR6,{CGNAT_V6},{name},no-resolve")),
    ];
    let mut accepted_routes = 0usize;
    for route in settings.routes.as_deref().unwrap_or_default() {
        let route = route.trim();
        if route.is_empty() {
            continue;
        }
        if !is_valid_cidr(route) {
            logging!(warn, Type::Config, "Ignoring invalid Tailscale route {route:?}");
            continue;
        }
        let kind = if route.contains(':') { "IP-CIDR6" } else { "IP-CIDR" };
        rules.push(Value::from(format!("{kind},{route},{name},no-resolve")));
        accepted_routes += 1;
    }

    let mut existing = config
        .remove(Value::from("rules"))
        .and_then(|value| value.as_sequence().cloned())
        .unwrap_or_default();
    rules.append(&mut existing);
    config.insert(Value::from("rules"), Value::Sequence(rules));

    inject_dns_policy(&mut config, name);
    logging!(
        info,
        Type::Config,
        "injected Tailscale outbound {name:?} with {accepted_routes} extra route(s)"
    );
    config
}

fn inject_dns_policy(config: &mut Mapping, name: &str) {
    let Some(dns) = config.get_mut(Value::from("dns")).and_then(Value::as_mapping_mut) else {
        return;
    };
    if !dns.get(Value::from("enable")).and_then(Value::as_bool).unwrap_or(false) {
        return;
    }
    let policy_key = Value::from("nameserver-policy");
    let mut policy = match dns.remove(&policy_key) {
        Some(Value::Mapping(policy)) => policy,
        Some(_) => Mapping::new(),
        None => Mapping::new(),
    };
    policy.insert(Value::from("+.ts.net"), Value::from(format!("tailscale://{name}")));
    dns.insert(policy_key, Value::Mapping(policy));
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::panic, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    fn settings() -> IVergeTailscale {
        IVergeTailscale {
            enable: Some(true),
            auth_key: Some("tskey-auth-test".into()),
            accept_routes: Some(true),
            routes: Some(vec!["192.168.20.0/24".into()]),
            ..Default::default()
        }
    }

    #[test]
    fn injects_the_outbound_rules_and_magic_dns() {
        let config: Mapping = serde_yaml_ng::from_str(
            "proxies:\n  - {name: node, type: ss}\nrules:\n  - MATCH,DIRECT\ndns:\n  enable: true\n",
        )
        .expect("valid yaml");

        let config = use_tailscale(config, Some(&settings()));

        let proxies = config
            .get(Value::from("proxies"))
            .and_then(Value::as_sequence)
            .expect("proxies");
        assert_eq!(proxies.len(), 2);
        let injected = proxies.last().and_then(Value::as_mapping).expect("injected proxy");
        assert_eq!(injected.get("name").and_then(Value::as_str), Some("TS"));
        assert_eq!(injected.get("type").and_then(Value::as_str), Some("tailscale"));
        assert_eq!(injected.get("state-dir").and_then(Value::as_str), Some("tailscale"));
        assert_eq!(injected.get("accept-routes").and_then(Value::as_bool), Some(true));

        let rules: Vec<&str> = config
            .get(Value::from("rules"))
            .and_then(Value::as_sequence)
            .expect("rules")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(
            rules,
            [
                "DOMAIN-SUFFIX,ts.net,TS",
                "IP-CIDR,100.64.0.0/10,TS,no-resolve",
                "IP-CIDR6,fd7a:115c:a1e0::/48,TS,no-resolve",
                "IP-CIDR,192.168.20.0/24,TS,no-resolve",
                "MATCH,DIRECT",
            ]
        );

        let policy = config
            .get(Value::from("dns"))
            .and_then(Value::as_mapping)
            .and_then(|dns| dns.get(Value::from("nameserver-policy")))
            .and_then(Value::as_mapping)
            .expect("nameserver-policy");
        assert_eq!(
            policy.get(Value::from("+.ts.net")).and_then(Value::as_str),
            Some("tailscale://TS")
        );
    }

    #[test]
    fn leaves_a_name_collision_alone() {
        let config: Mapping = serde_yaml_ng::from_str("proxies:\n  - {name: TS, type: ss}\n").expect("valid yaml");
        let before = config.clone();
        assert_eq!(use_tailscale(config, Some(&settings())), before);
    }

    #[test]
    fn ignores_invalid_routes() {
        let config: Mapping = serde_yaml_ng::from_str("rules:\n  - MATCH,DIRECT\n").expect("valid yaml");
        let mut settings = settings();
        settings.routes = Some(vec!["not-a-cidr".into()]);
        let config = use_tailscale(config, Some(&settings));
        let rules: Vec<&str> = config
            .get(Value::from("rules"))
            .and_then(Value::as_sequence)
            .expect("rules")
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert_eq!(rules.len(), 4);
        assert_eq!(rules[3], "MATCH,DIRECT");
    }
}
