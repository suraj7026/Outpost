//! Two independently authenticated installations; encrypted packets never cross React IPC.
use super::*;
use std::collections::BTreeMap;
use std::sync::LazyLock;

fn public_inventory(inventory: &Value) -> Value {
    json!({"installationId":inventory["installationId"], "providers":inventory["providers"].as_array().map(|providers| providers.iter().map(|p|
        json!({"id":p["id"],"name":p["name"],"method":p["method"],"baseUrl":p["baseUrl"]})
    ).collect::<Vec<_>>()).unwrap_or_default()})
}
fn public_receipt(value: &Value) -> Value {
    json!({"operationId":value["operationId"],"state":value["state"],"providers":value["providers"].as_array().map(|providers| providers.iter().map(|p|
        json!({"id":p["id"],"state":p["state"]})
    ).collect::<Vec<_>>()).unwrap_or_default()})
}
struct Review {
    source: String,
    destination: String,
    inventory: Value,
    target: Value,
    expires: u64,
}
static REVIEWS: LazyLock<Mutex<BTreeMap<String, Review>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

#[tauri::command]
pub async fn provider_transfer_review(
    registry: tauri::State<'_, environments::Registry>,
    source: String,
    destination: String,
) -> Result<Value, String> {
    if source == destination {
        return Err("Choose a different source server".into());
    }
    let from = registry.get(&source)?;
    let to = registry.get(&destination)?;
    let inventory = from
        .agent_request(json!({"type":"transfer.inventory"}))
        .await?;
    let target = to
        .agent_request(json!({"type":"transfer.inventory"}))
        .await?;
    if inventory["installationId"] == target["installationId"] {
        return Err("These connections reach the same Pi profile".into());
    }
    let id = Uuid::new_v4().to_string();
    let result = json!({"reviewId":id,"source":public_inventory(&inventory),"destination":public_inventory(&target)});
    let mut reviews = REVIEWS
        .lock()
        .map_err(|_| "Transfer review lock unavailable")?;
    reviews.retain(|_, review| review.expires > now_ms());
    if reviews.len() >= 16 {
        return Err("Too many pending transfer reviews".into());
    }
    reviews.insert(
        id,
        Review {
            source,
            destination,
            inventory,
            target,
            expires: now_ms() + 300000,
        },
    );
    Ok(result)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generic_ipc_cannot_export_packets_or_bypass_native_maintenance_approval() {
        for kind in [
            "transfer.prepare",
            "transfer.export",
            "transfer.apply",
            "maintenance.stage",
            "maintenance.prepare",
            "maintenance.hold",
            "maintenance.release",
            "maintenance.cancel",
        ] {
            assert!(public_management_request(&json!({"type":kind})).is_err());
        }
        for kind in [
            "transfer.inventory",
            "transfer.history",
            "transfer.status",
            "transfer.cancel",
            "runtime.inventory",
            "maintenance.status",
            "login.start",
        ] {
            assert!(public_management_request(&json!({"type":kind})).is_ok());
        }
        let private = json!({"installationId":"id","operationId":"op","state":"complete","ciphertext":"private-packet","providers":[{"id":"openai","state":"saved","method":"api_key","key":"private-key","configuration":{"secret":"private-config"},"revision":"private-revision"}]});
        assert!(!public_inventory(&private).to_string().contains("private-"));
        assert!(!public_receipt(&private).to_string().contains("private-"));
        assert!(serde_json::from_value::<Selection>(
            json!({"id":"openai","replace":false,"key":"must-not-enter-ipc"})
        )
        .is_err());
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Selection {
    id: String,
    replace: bool,
}
#[tauri::command]
pub async fn provider_transfer_start(
    registry: tauri::State<'_, environments::Registry>,
    review_id: String,
    operation_id: String,
    selection: Vec<Selection>,
    approved: bool,
) -> Result<Value, String> {
    environments::validate_id(&operation_id)?;
    if !approved || selection.is_empty() || selection.len() > 16 {
        return Err("Review and approve selected providers first".into());
    }
    let review = REVIEWS
        .lock()
        .map_err(|_| "Transfer review lock unavailable")?
        .remove(&review_id)
        .ok_or("Review expired; inspect both servers again")?;
    if review.expires <= now_ms() {
        return Err("Review expired; inspect both servers again".into());
    }
    let from = registry.get(&review.source)?;
    let to = registry.get(&review.destination)?;
    let providers = review.inventory["providers"]
        .as_array()
        .ok_or("Invalid source inventory")?;
    let mut selected = Vec::new();
    for item in selection {
        let provider = providers
            .iter()
            .find(|p| p["id"].as_str() == Some(&item.id))
            .ok_or("Provider was not reviewed")?;
        selected.push(json!({"provider":provider,"replace":item.replace}));
    }
    let ticket = to
        .agent_request(json!({"type":"transfer.prepare","operationId":operation_id,
        "source":review.inventory,"destination":review.target,"selection":selected}))
        .await?;
    let packet = from
        .agent_request(json!({"type":"transfer.export","ticket":ticket}))
        .await?;
    // No persistence and no automatic retry. Reconcile through the destination's durable receipt.
    let result = to
        .agent_request(json!({"type":"transfer.apply","sealed":packet}))
        .await?;
    Ok(public_receipt(&result))
}
