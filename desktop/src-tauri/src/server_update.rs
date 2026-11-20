//! Qualified bundled updates over pinned SSH. Reviews/receipts contain no credentials.
use super::install::{public_identity, python, resource};
use super::*;
#[path = "server_auto_update.rs"]
pub mod automatic;
static ACTIVE: std::sync::LazyLock<Mutex<std::collections::BTreeSet<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::BTreeSet::new()));
struct UpdateGuard(String);
impl Drop for UpdateGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE.lock() {
            active.remove(&self.0);
        }
    }
}
fn acquire(environment: &str) -> Result<UpdateGuard, String> {
    if !ACTIVE
        .lock()
        .map_err(|_| "Update lock unavailable")?
        .insert(environment.into())
    {
        return Err("An update check is already in progress for this server".into());
    }
    Ok(UpdateGuard(environment.into()))
}
const COMMON: &str = include_str!("../../../deploy/environment/common.py");
const UPDATER: &str = include_str!("../../../deploy/environment/host_update.py");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ArtifactResource {
    Host,
    Pi,
}

impl ArtifactResource {
    fn name(self) -> &'static str {
        match self {
            Self::Host => "host-release",
            Self::Pi => "pi-release",
        }
    }

    fn metadata(self) -> &'static str {
        match self {
            Self::Host => "host-release.json",
            Self::Pi => "pi-release.json",
        }
    }

    fn archive(self) -> &'static str {
        match self {
            Self::Host => "host-release.tar.gz",
            Self::Pi => "pi-release.tar.gz",
        }
    }
}

fn is_sha256(value: &Value) -> bool {
    value.as_str().is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

const MAX_COMPATIBLE_SOURCE_RELEASES: usize = 16;

fn canonical_host_release(id: &str) -> bool {
    id.strip_prefix("host-").is_some_and(|hash| {
        hash.len() == 20
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn pi_source_releases(artifact: &Value) -> Result<Vec<&str>, String> {
    let baseline = artifact["sourceRelease"]
        .as_str()
        .filter(|id| canonical_host_release(id))
        .ok_or("Invalid Pi-only source release")?;
    let Some(list) = artifact.get("compatibleSourceReleases") else {
        return Ok(vec![baseline]);
    };
    let list = list
        .as_array()
        .ok_or("Invalid Pi-only compatible source releases")?;
    if list.is_empty() || list.len() > MAX_COMPATIBLE_SOURCE_RELEASES {
        return Err("Invalid Pi-only compatible source release count".into());
    }
    let mut sources = Vec::with_capacity(list.len());
    for source in list {
        let source = source
            .as_str()
            .filter(|id| canonical_host_release(id))
            .ok_or("Invalid Pi-only compatible source release")?;
        if sources.contains(&source) {
            return Err("Duplicate Pi-only compatible source release".into());
        }
        sources.push(source);
    }
    if !sources.contains(&baseline) {
        return Err("Pi-only compatible source releases omit the baseline".into());
    }
    Ok(sources)
}

fn newer_artifact(installed: &Value, artifact: &Value) -> bool {
    installed["manifest"]["sequence"]
        .as_u64()
        .zip(artifact["manifest"]["sequence"].as_u64())
        .is_some_and(|(source, target)| target > source)
        && installed["releaseId"] != artifact["manifest"]["id"]
}

fn validate_artifact(artifact: &Value, resource: ArtifactResource) -> Result<(), String> {
    if artifact["schema"] != 1
        || artifact["id"].as_str().is_none_or(str::is_empty)
        || artifact["manifest"]["id"] != artifact["id"]
        || artifact["manifest"]["schema"] != 2
        || artifact["manifest"]["compatibility"] != "native-v1"
        || artifact["manifest"]["sequence"].as_u64().is_none()
        || !is_sha256(&artifact["sha256"])
        || !is_sha256(&artifact["runtimePinsSha256"])
        || !artifact["size"]
            .as_u64()
            .is_some_and(|size| size > 0 && size <= 16 * 1024 * 1024)
        || (resource == ArtifactResource::Pi
            && (!matches!(
                artifact["updateScope"].as_str(),
                Some("pi-only" | "compatible-server")
            ) || artifact["sourceRelease"].as_str().is_none_or(str::is_empty)))
    {
        return Err(format!("Invalid bundled {} metadata", resource.name()));
    }
    if resource == ArtifactResource::Pi {
        pi_source_releases(artifact)?;
        if artifact["updateScope"] == "compatible-server" {
            automatic::verify_authorization(artifact, None)?;
        }
    }
    Ok(())
}

fn read_artifact(path: &PathBuf, resource: ArtifactResource) -> Result<Option<Value>, String> {
    // Only absence is optional. Unreadable files, dangling links and malformed metadata fail closed.
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Bundled release metadata unavailable".into()),
        Ok(_) => {}
    }
    let bytes = fs::read(path).map_err(|_| "Bundled release metadata unreadable")?;
    let artifact =
        serde_json::from_slice(&bytes).map_err(|_| "Invalid bundled release metadata")?;
    validate_artifact(&artifact, resource)?;
    Ok(Some(artifact))
}

fn bundled_artifact(
    app: &tauri::AppHandle,
    resource: ArtifactResource,
) -> Result<Option<Value>, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|_| "App resources unavailable")?
        .join(resource.metadata());
    if let Some(artifact) = read_artifact(&path, resource)? {
        return Ok(Some(artifact));
    }
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join(resource.metadata());
        return read_artifact(&path, resource);
    }
    #[cfg(not(debug_assertions))]
    Ok(None)
}

const RUNTIME_PINS_PROBE: &str = r#"import hashlib,json,pathlib,re
prefix=pathlib.Path('/opt/outpost-native')
releases=prefix/'releases'
current=(prefix/'current').resolve(strict=True)
if prefix.resolve(strict=True)!=prefix or releases.resolve(strict=True)!=releases or current.parent!=releases or not re.fullmatch(r'host-[a-f0-9]{20}',current.name):
 raise ValueError('Unsupported release path')
manifest=current/'host-manifest.json'
pins=current/'deploy/environment/runtime-pins.json'
for path in (manifest,pins):
 if path.resolve(strict=True)!=path or not path.is_file():
  raise ValueError('Unsupported metadata path')
release=json.loads(manifest.read_text())['id']
if release!=current.name:
 raise ValueError('Release identity mismatch')
digest=hashlib.sha256(pins.read_bytes()).hexdigest()
if (prefix/'current').resolve(strict=True)!=current:
 raise ValueError('Release changed during probe')
print(json.dumps({'releaseId':release,'runtimePinsSha256':digest}))
"#;

fn probe_runtime_pins(setup: &Setup, setup_id: &str) -> Result<Value, String> {
    let entry = setup.entry(setup_id)?;
    let mut args = setup.ssh_args(&entry)?;
    args.extend([
        "--".into(),
        entry.target.host.clone(),
        python(RUNTIME_PINS_PROBE),
    ]);
    let bytes = run(
        setup.ssh_program(),
        &args,
        b"",
        Duration::from_secs(15),
        &AtomicBool::new(false),
    )
    .map_err(|_| {
        "Could not verify public release metadata over pinned SSH; no update was authorized"
    })?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid server runtime-pins probe".into())
}

fn signed_runtime_family_matches(
    installed: &Value,
    probe: &Value,
    artifact: &Value,
) -> Result<bool, String> {
    automatic::verify_authorization(artifact, None)?;
    automatic::validate_manifest(&installed["manifest"])?;
    let release = installed["releaseId"]
        .as_str()
        .filter(|id| canonical_host_release(id))
        .ok_or("Invalid signed source release")?;
    if installed["manifest"]["id"] != release
        || probe["releaseId"] != release
        || !is_sha256(&probe["runtimePinsSha256"])
    {
        return Err("Runtime family probe is not bound to the authenticated source release".into());
    }
    Ok(probe["runtimePinsSha256"] == artifact["runtimePinsSha256"])
}
fn release_review_message(resource: ArtifactResource, artifact: &Value) -> &'static str {
    if artifact["updateScope"] == "compatible-server" {
        "Review the signed compatible-server release. Coordinator, worker, host executor and required tools are updated together; browser/runtime pins, credentials and history are preserved."
    } else if artifact.get("authorization").is_some() {
        "Review the complete signed server release. Coordinator, worker, host executor and required tools are updated together; credentials and history are preserved."
    } else if resource == ArtifactResource::Pi {
        "Review the Pi-only update. Coordinator and browser source, runtime pins, existing credentials and history are preserved."
    } else {
        "Review the bundled Pi and extension changes. Existing credentials, browser runtime and history are preserved."
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckOutcome {
    UpdateAvailable,
    UpToDate,
    Blocked,
}

fn release_check(
    installed: &Value,
    resource: ArtifactResource,
    artifact: &Value,
    pinned_ssh: bool,
    compatible: bool,
) -> (CheckOutcome, &'static str) {
    let source = &installed["manifest"];
    let target = &artifact["manifest"];
    if source["schema"] != 2
        || source["compatibility"] != "native-v1"
        || target["schema"] != 2
        || target["compatibility"] != "native-v1"
    {
        return (CheckOutcome::Blocked, "This installation needs a qualified native maintenance release. Ask the server administrator to qualify a supported installation; legacy/container installations are not reinstalled automatically.");
    }
    if !pinned_ssh {
        return (CheckOutcome::Blocked, "Save and verify a pinned SSH connection for this server in Server Settings before checking for a native update. No update was started.");
    }
    if !compatible {
        return (CheckOutcome::Blocked, "No bundled release matches this server's runtime pins. Use an Outpost app release qualified for this runtime family, or ask the administrator to qualify a browser/runtime migration separately. No update was started.");
    }
    if newer_artifact(installed, artifact) {
        let message = if artifact.get("authorization").is_some() {
            "Review the complete publisher-signed native release. Coordinator, worker and required tools are updated together; browser/runtime pins, credentials and history are preserved."
        } else {
            release_review_message(resource, artifact)
        };
        return (CheckOutcome::UpdateAvailable, message);
    }
    if installed["releaseId"]
        .as_str()
        .is_some_and(|id| !id.is_empty() && artifact["id"] == id && target["id"] == id)
        && source == target
        && target["sequence"].as_u64().is_some()
    {
        return (CheckOutcome::UpToDate, "This server exactly matches the compatible release bundled with this app. This does not check for newer releases outside this app.");
    }
    let message = match source["sequence"].as_u64().zip(target["sequence"].as_u64()) {
        Some((current, bundled)) if bundled < current =>
            "This app bundles an older release than this server. Update the Outpost app to obtain a newer qualified release; downgrades are blocked. No update was started.",
        Some((current, bundled)) if bundled == current =>
            "The installed and bundled releases have the same sequence but different release identities or manifests. Obtain a newer qualified Outpost app release or ask the administrator to verify the release metadata. No update was started.",
        _ =>
            "The installed and bundled release identities or sequences do not permit a verified forward update. Ask the administrator to verify the release metadata and use a newer qualified Outpost app release. No update was started.",
    };
    (CheckOutcome::Blocked, message)
}

fn select_artifact<'a>(
    installed: &Value,
    probe: &Value,
    host: &'a Value,
    pi: Option<&'a Value>,
) -> Result<Option<(ArtifactResource, &'a Value)>, String> {
    validate_artifact(host, ArtifactResource::Host)?;
    if host.get("authorization").is_some() {
        automatic::verify_authorization(host, None)?;
    }
    if let Some(pi) = pi {
        validate_artifact(pi, ArtifactResource::Pi)?;
        if pi.get("authorization").is_some() {
            automatic::verify_authorization(
                pi,
                host["authorization"]["publisherPublicKey"].as_str(),
            )?;
        }
    }
    let release = installed["releaseId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Missing signed source release")?;
    if probe["releaseId"].as_str() != Some(release)
        || installed["manifest"]["id"].as_str() != Some(release)
        || !is_sha256(&probe["runtimePinsSha256"])
    {
        return Err(
            "Server release/pins probe does not match the signed installed release; check again"
                .into(),
        );
    }
    // Prefer the newest complete signed compatible release, never an unsigned fallback.
    let mut authorized = Vec::new();
    if host.get("authorization").is_some() && signed_runtime_family_matches(installed, probe, host)?
    {
        authorized.push((ArtifactResource::Host, host));
    }
    if let Some(pi) = pi {
        if pi.get("authorization").is_some()
            && (pi["updateScope"] == "compatible-server"
                || pi_source_releases(pi)?.contains(&release))
            && signed_runtime_family_matches(installed, probe, pi)?
        {
            authorized.push((ArtifactResource::Pi, pi));
        }
    }
    if let Some(selected) = authorized
        .into_iter()
        .max_by_key(|(_, artifact)| artifact["manifest"]["sequence"].as_u64().unwrap_or(0))
    {
        return Ok(Some(selected));
    }
    if host.get("authorization").is_some()
        || pi.is_some_and(|artifact| artifact.get("authorization").is_some())
    {
        return Ok(None);
    }
    if let Some(pi) = pi {
        if pi_source_releases(pi)?.contains(&release)
            && pi["runtimePinsSha256"] == probe["runtimePinsSha256"]
        {
            return Ok(Some((ArtifactResource::Pi, pi)));
        }
    }
    Ok((host["runtimePinsSha256"] == probe["runtimePinsSha256"])
        .then_some((ArtifactResource::Host, host)))
}

fn review_archive(review: &Value) -> Result<&'static str, String> {
    let resource = match review.get("artifactResource") {
        None => ArtifactResource::Host, // Reviews saved by older apps always used the main archive.
        Some(Value::String(name)) if name == "host-release" => ArtifactResource::Host,
        Some(Value::String(name)) if name == "pi-release" => ArtifactResource::Pi,
        _ => return Err("Invalid reviewed artifact resource".into()),
    };
    if resource == ArtifactResource::Pi && review["artifact"]["updateScope"] == "compatible-server"
    {
        validate_artifact(&review["artifact"], resource)?;
        if !signed_runtime_family_matches(
            &review["installed"],
            &review["runtimePinsProbe"],
            &review["artifact"],
        )? || !newer_artifact(&review["installed"], &review["artifact"])
        {
            return Err("Compatible-server review no longer admits this update".into());
        }
        return Ok(resource.archive());
    }
    if resource == ArtifactResource::Pi {
        let source = review["installed"]["releaseId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Missing reviewed source release")?;
        if !pi_source_releases(&review["artifact"])?.contains(&source)
            || review["artifact"]["updateScope"] != "pi-only"
        {
            return Err("Pi-only artifact does not match the reviewed source release".into());
        }
    }
    Ok(resource.archive())
}

fn retain_previous_review(review: &Value) -> bool {
    !["review", "complete", "rolled_back", "failed", "cancelled"]
        .contains(&review["state"].as_str().unwrap_or("unknown"))
}

fn manual_bootstrap_command(root: bool, password: bool) -> String {
    let authority = if root {
        ""
    } else if password {
        "sudo -k -S -p '' -- "
    } else {
        "sudo -n -- "
    };
    format!(
        "{authority}{} --bootstrap",
        automatic::isolated_python(automatic::BOOTSTRAP_LOADER)
    )
}

fn bootstrap_source(
    common: &str,
    updater: &str,
    operation: &str,
    environment: &str,
) -> Result<String, String> {
    environments::validate_id(operation)?;
    environments::validate_id(environment)?;
    // Bind diagnostics independently of stdin: decoding the launch frame may itself fail.
    // Exceptions can occur after launch, so none of these categories establishes its outcome.
    Ok(format!(
        r#"import base64,types,sys,json
try:
 m=types.ModuleType('common');sys.modules['common']=m
 exec(base64.b64decode('{common}'),m.__dict__)
 exec(base64.b64decode('{updater}'))
except Exception as error:
 if isinstance(error,json.JSONDecodeError):
  code,stage='invalid_launch_frame','Bootstrap JSON decoding failed. Launch outcome remains unknown; check status.'
 elif isinstance(error,ValueError):
  code,stage='invalid_release_packet','Bootstrap validation failed. Launch outcome remains unknown; check status.'
 elif isinstance(error,OSError):
  code,stage='launcher_io_failed','Bootstrap I/O failed. Launch outcome remains unknown; check status.'
 else:
  code,stage='launcher_failed','Bootstrap execution failed. Launch outcome remains unknown; check status.'
 print(json.dumps({{'operationId':'{operation}','environmentId':'{environment}','state':'unknown','launchError':code,'stage':stage}}))
"#,
        common = STANDARD.encode(common),
        updater = STANDARD.encode(updater),
    ))
}

fn can_cancel(state: &Value) -> bool {
    matches!(
        state.as_str(),
        Some("authorizing" | "queued" | "staging" | "waiting_for_idle" | "unknown")
    )
}

fn cancellation_binding_owner<'a>(review: &'a Value, field: &str) -> Option<&'a str> {
    let record = &review[field];
    for key in ["operationId", "environmentId"] {
        let binding = review[key].as_str().filter(|id| !id.is_empty())?;
        if record[key].as_str() != Some(binding) {
            return None;
        }
    }
    record["owner"].as_str().filter(|id| !id.is_empty())
}

fn cancellation_intent_owner(review: &Value) -> Option<&str> {
    cancellation_binding_owner(review, "cancellationIntent")
}

fn cancellation_confirmed(review: &Value) -> bool {
    cancellation_intent_owner(review).is_some_and(|owner| {
        cancellation_binding_owner(review, "cancellationConfirmed") == Some(owner)
    })
}

fn bound_host_failure(review: &Value) -> bool {
    review["progress"]["state"] == "failed"
        && bound_host_receipt(
            review,
            &review["progress"],
            review["environmentId"].as_str().unwrap_or(""),
        )
}

fn save_cancellation_intent(
    setup: &Setup,
    environment: &str,
    review: &mut Value,
    owner: &str,
) -> Result<(), String> {
    if review["environmentId"].as_str() != Some(environment)
        || environment.is_empty()
        || review["operationId"].as_str().is_none_or(str::is_empty)
        || owner.is_empty()
    {
        return Err("Invalid cancellation binding".into());
    }
    review["cancellationIntent"] = json!({
        "operationId": review["operationId"],
        "environmentId": environment,
        "owner": owner,
    });
    save(setup, environment, review)
}

fn coordinator_cancelled(review: &Value, reply: &Value, owner: &str) -> bool {
    let operation = review["operationId"].as_str().filter(|id| !id.is_empty());
    operation.is_some()
        && reply["operationId"].as_str() == operation
        && !owner.is_empty()
        && reply["owner"].as_str() == Some(owner)
        && reply["state"] == "cancelled"
}

fn apply_cancel_reply(
    review: &mut Value,
    reply: Result<Value, String>,
    owner: &str,
) -> Result<Value, String> {
    // Only a validated direct maintenance.cancel reply establishes acknowledgement.
    // String errors cannot distinguish rejection from a lost reply; retain intent in either case.
    let reply = reply?;
    if cancellation_intent_owner(review) != Some(owner)
        || !coordinator_cancelled(review, &reply, owner)
    {
        return Err("Cancellation was not confirmed for this device and operation. Check status; the launch will not be repeated.".into());
    }
    review["cancellationConfirmed"] = review["cancellationIntent"].clone();
    reconcile_cancelled(review, &reply, owner);
    Ok(reply)
}

fn reconcile_cancelled(review: &mut Value, reply: &Value, owner: &str) -> bool {
    if cancellation_intent_owner(review) != Some(owner)
        || !coordinator_cancelled(review, reply, owner)
        || (bound_host_failure(review) && !cancellation_confirmed(review))
    {
        return false;
    }
    review["state"] = json!("cancelled");
    if !review["progress"].is_object() {
        review["progress"] = json!({});
    }
    // Cleanup can also cancel the reservation. Never erase a host failure or its diagnostics.
    let key = if bound_host_receipt(
        review,
        &review["progress"],
        review["environmentId"].as_str().unwrap_or(""),
    ) {
        "cancellationNote"
    } else {
        "stage"
    };
    review["progress"][key] =
        json!("Server confirmed the requested cancellation before activation.");
    true
}

fn bound_host_receipt(review: &Value, status: &Value, environment: &str) -> bool {
    let operation = review["operationId"].as_str().filter(|id| !id.is_empty());
    if operation.is_none()
        || environment.is_empty()
        || review["environmentId"].as_str() != Some(environment)
        || status["operationId"].as_str() != operation
        || status["environmentId"].as_str() != Some(environment)
        || !matches!(
            status["state"].as_str(),
            Some(
                "queued"
                    | "staging"
                    | "waiting_for_idle"
                    | "activating"
                    | "recovering"
                    | "complete"
                    | "rolled_back"
                    | "failed"
                    | "needs_attention"
                    | "unknown"
            )
        )
    {
        return false;
    }
    true
}

fn apply_host_receipt(review: &mut Value, status: Value, environment: &str) -> bool {
    if !bound_host_receipt(review, &status, environment) {
        return false;
    }
    review["state"] = status["state"].clone();
    review["progress"] = status;
    true
}

fn unknown_stage(review: &mut Value, stage: &str) {
    if review["state"] == "unknown" {
        if !review["progress"].is_object() {
            review["progress"] = json!({});
        }
        review["progress"]["stage"] = json!(stage);
    }
}

fn apply_launch_result(review: &mut Value, environment: &str, result: Result<Vec<u8>, String>) {
    match result {
        Ok(reply) => {
            if !serde_json::from_slice::<Value>(&reply)
                .is_ok_and(|status| apply_host_receipt(review, status, environment))
            {
                unknown_stage(review, "Launch reply could not be verified. Check status; the launch will not be retried automatically.");
            }
        }
        Err(_) => unknown_stage(review, "Update launch could not be confirmed over SSH. Check status; the launch will not be retried automatically."),
    }
}

fn apply_host_status(review: &mut Value, status: Value, environment: &str) {
    // This is the read-only probe's missing-file sentinel, not cancellation evidence.
    if status == json!({"state":"unknown"}) {
        let note = "No host update receipt is available; launch remains unconfirmed. Server-guarded cancellation is available if activation has not begun. No launch will be retried automatically.";
        if review["state"] == "unknown" && review["progress"]["launchError"].is_string() {
            review["progress"]["receiptNote"] = json!(note);
        } else {
            unknown_stage(review, note);
        }
    } else {
        apply_host_receipt(review, status, environment);
    }
}

fn needs_host_status(review: &Value) -> bool {
    // In particular, legacy cancelled reviews must be repaired from host evidence.
    review["state"] != "review"
}

fn reconcile_status(
    review: &mut Value,
    environment: &str,
    host: Result<Value, String>,
    coordinator: Option<(&Value, &str)>,
) -> Result<(), String> {
    let was_cancelled = review["state"] == "cancelled";
    let preserve_cancellation = cancellation_confirmed(review)
        || (was_cancelled && cancellation_intent_owner(review).is_some());
    if was_cancelled && !preserve_cancellation {
        review["state"] = json!("unknown");
        let previous = review["progress"].clone();
        if !apply_host_receipt(review, previous, environment) {
            unknown_stage(review, "Previous cancellation has no verified host outcome. The reservation may have been aborted; check status. No launch will be retried automatically.");
        }
    }
    let host_error = match host {
        Ok(status) => {
            apply_host_status(review, status, environment);
            None
        }
        Err(error) => Some(error),
    };
    let contrary_host_failure = bound_host_failure(review) && !cancellation_confirmed(review);
    if contrary_host_failure {
        review["state"] = json!("failed");
        if let Some(progress) = review["progress"].as_object_mut() {
            progress.remove("cancellationNote");
        }
    }
    let mut aborted_reservation = false;
    if let Some((reply, owner)) = coordinator {
        aborted_reservation = coordinator_cancelled(review, reply, owner);
        if aborted_reservation
            && !reconcile_cancelled(review, reply, owner)
            && !bound_host_receipt(review, &review["progress"], environment)
        {
            review["state"] = json!("unknown");
            unknown_stage(review, "The update reservation was aborted, but no bound host receipt is available. The host outcome is unknown; user cancellation is not confirmed. No launch will be retried automatically.");
        }
    }
    // Guarded status reconciliation is provisional: contrary host evidence can correct it.
    // Only a persisted direct acknowledgement survives a later host cleanup failure.
    if preserve_cancellation && !contrary_host_failure {
        review["state"] = json!("cancelled");
    }
    if let Some(error) = host_error {
        if !aborted_reservation && !preserve_cancellation && !was_cancelled {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPERATION: &str = "00000000-0000-4000-8000-000000000001";
    const ENVIRONMENT: &str = "00000000-0000-4000-8000-000000000002";
    const SOURCE_RELEASE: &str = "host-e89b6404f05c3a07c0f6";
    const PRIOR_PI_RELEASE: &str = "host-24b08c6bb80dd3932f21";

    fn native_extensions_artifact() -> Value {
        let mut pi = artifact_fixture(ArtifactResource::Pi, &"b".repeat(64));
        pi["manifest"]["sequence"] = json!(3);
        pi["compatibleSourceReleases"] = json!([SOURCE_RELEASE, PRIOR_PI_RELEASE]);
        pi["extensionPolicy"] = json!("native-installed");
        pi
    }

    #[test]
    fn native_extensions_pi_artifact_accepts_both_explicit_sources() {
        let pi = native_extensions_artifact();
        let host = artifact_fixture(ArtifactResource::Host, &"c".repeat(64));
        for (release, sequence) in [(SOURCE_RELEASE, 1), (PRIOR_PI_RELEASE, 2)] {
            let mut installed = installed_fixture();
            installed["releaseId"] = json!(release);
            installed["manifest"]["id"] = json!(release);
            installed["manifest"]["sequence"] = json!(sequence);
            let mut probe = pins_fixture();
            probe["releaseId"] = json!(release);
            let (resource, artifact) = select_artifact(&installed, &probe, &host, Some(&pi))
                .unwrap()
                .unwrap();
            assert_eq!(resource, ArtifactResource::Pi);
            assert_eq!(artifact["sourceRelease"], SOURCE_RELEASE);
            assert_eq!(artifact["extensionPolicy"], "native-installed");
            assert!(newer_artifact(&installed, artifact));
            let review = json!({"artifactResource":resource.name(),"installed":installed,"artifact":artifact});
            assert_eq!(review_archive(&review).unwrap(), "pi-release.tar.gz");
        }
    }

    #[test]
    fn legacy_pi_metadata_remains_exact_source_only() {
        let pi = artifact_fixture(ArtifactResource::Pi, &"b".repeat(64));
        assert_eq!(pi_source_releases(&pi).unwrap(), vec![SOURCE_RELEASE]);
        let host = artifact_fixture(ArtifactResource::Host, &"c".repeat(64));
        let mut installed = installed_fixture();
        installed["releaseId"] = json!(PRIOR_PI_RELEASE);
        installed["manifest"]["id"] = json!(PRIOR_PI_RELEASE);
        let mut probe = pins_fixture();
        probe["releaseId"] = json!(PRIOR_PI_RELEASE);
        assert!(select_artifact(&installed, &probe, &host, Some(&pi))
            .unwrap()
            .is_none());
        let review = json!({"artifactResource":"pi-release","installed":installed,"artifact":pi});
        assert!(review_archive(&review).is_err());
    }

    #[test]
    fn malformed_compatible_source_lists_fail_closed_in_selection_and_start() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        let mut over_limit: Vec<Value> = (0..MAX_COMPATIBLE_SOURCE_RELEASES)
            .map(|index| json!(format!("host-{index:020x}")))
            .collect();
        over_limit.push(json!(SOURCE_RELEASE));
        for list in [
            Value::Null,
            json!(true),
            json!(SOURCE_RELEASE),
            json!({"sourceRelease":SOURCE_RELEASE}),
            json!([]),
            json!([PRIOR_PI_RELEASE]),
            json!([SOURCE_RELEASE, SOURCE_RELEASE]),
            json!([SOURCE_RELEASE, 42]),
            json!([SOURCE_RELEASE, null]),
            json!([SOURCE_RELEASE, "unknown"]),
            json!([SOURCE_RELEASE, "host-*"]),
            json!([SOURCE_RELEASE, "host-24B08C6BB80DD3932F21"]),
            json!([SOURCE_RELEASE, "host-24b08c6bb80dd3932f2"]),
            json!([SOURCE_RELEASE, "host-24b08c6bb80dd3932f210"]),
            json!([SOURCE_RELEASE, "../host-24b08c6bb80dd3932f21"]),
            json!([SOURCE_RELEASE, "host-24b08c6bb80dd3932f21\n"]),
            json!(over_limit),
        ] {
            let mut pi = native_extensions_artifact();
            pi["compatibleSourceReleases"] = list;
            assert!(
                select_artifact(&installed_fixture(), &pins_fixture(), &host, Some(&pi)).is_err()
            );
            let review = json!({"artifactResource":"pi-release","installed":installed_fixture(),"artifact":pi});
            assert!(review_archive(&review).is_err());
        }
        for baseline in [Value::Null, json!("host-*"), json!("unknown")] {
            let mut pi = native_extensions_artifact();
            pi["sourceRelease"] = baseline;
            assert!(validate_artifact(&pi, ArtifactResource::Pi).is_err());
            let review = json!({"artifactResource":"pi-release","installed":installed_fixture(),"artifact":pi});
            assert!(review_archive(&review).is_err());
        }
    }

    #[test]
    fn compatible_source_list_accepts_its_exact_size_bound() {
        let mut pi = native_extensions_artifact();
        let mut sources: Vec<Value> = (0..MAX_COMPATIBLE_SOURCE_RELEASES - 1)
            .map(|index| json!(format!("host-{index:020x}")))
            .collect();
        sources.push(json!(SOURCE_RELEASE));
        pi["compatibleSourceReleases"] = json!(sources);
        assert_eq!(
            pi_source_releases(&pi).unwrap().len(),
            MAX_COMPATIBLE_SOURCE_RELEASES
        );
        validate_artifact(&pi, ArtifactResource::Pi).unwrap();
    }

    #[test]
    fn unlisted_sources_never_gain_pi_compatibility_from_a_known_family() {
        let pi = native_extensions_artifact();
        let mut installed = installed_fixture();
        let unlisted = "host-24b08c6bb80dd3932f22";
        installed["releaseId"] = json!(unlisted);
        installed["manifest"]["id"] = json!(unlisted);
        let mut probe = pins_fixture();
        probe["releaseId"] = json!(unlisted);
        let incompatible_host = artifact_fixture(ArtifactResource::Host, &"c".repeat(64));
        assert!(
            select_artifact(&installed, &probe, &incompatible_host, Some(&pi))
                .unwrap()
                .is_none()
        );
        let compatible_host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        assert_eq!(
            select_artifact(&installed, &probe, &compatible_host, Some(&pi)).unwrap(),
            Some((ArtifactResource::Host, &compatible_host))
        );
        let review = json!({"artifactResource":"pi-release","installed":installed,"artifact":pi});
        assert!(review_archive(&review).is_err());
    }

    #[test]
    fn compatible_source_list_does_not_relax_signed_probe_or_runtime_pin_bindings() {
        let mut pi = native_extensions_artifact();
        let host = artifact_fixture(ArtifactResource::Host, &"c".repeat(64));
        let mut installed = installed_fixture();
        installed["releaseId"] = json!(PRIOR_PI_RELEASE);
        installed["manifest"]["id"] = json!(PRIOR_PI_RELEASE);
        let mut probe = pins_fixture();
        // Both IDs are allowlisted, but the probe still must match this signed source exactly.
        assert!(select_artifact(&installed, &probe, &host, Some(&pi)).is_err());
        probe["releaseId"] = json!(PRIOR_PI_RELEASE);
        pi["runtimePinsSha256"] = json!("d".repeat(64));
        assert!(select_artifact(&installed, &probe, &host, Some(&pi))
            .unwrap()
            .is_none());
    }

    #[test]
    fn compatible_source_list_cannot_bypass_newer_sequence_requirement() {
        let pi = native_extensions_artifact();
        let mut installed = installed_fixture();
        installed["releaseId"] = json!(PRIOR_PI_RELEASE);
        installed["manifest"]["id"] = json!(PRIOR_PI_RELEASE);
        for (sequence, expected) in [(1, true), (2, true), (3, false), (4, false)] {
            installed["manifest"]["sequence"] = json!(sequence);
            assert_eq!(newer_artifact(&installed, &pi), expected);
        }
        for sequence in [Value::Null, json!("2"), json!(-1)] {
            installed["manifest"]["sequence"] = sequence;
            assert!(!newer_artifact(&installed, &pi));
        }
        installed["manifest"]["sequence"] = json!(2);
        installed["releaseId"] = pi["manifest"]["id"].clone();
        assert!(!newer_artifact(&installed, &pi));
    }

    fn artifact_fixture(resource: ArtifactResource, hash: &str) -> Value {
        let id = match resource {
            ArtifactResource::Host => "host-11111111111111111111",
            ArtifactResource::Pi => "host-22222222222222222222",
        };
        let mut artifact = json!({"schema":1,"id":id,"sha256":"a".repeat(64),"size":1024,
            "runtimePinsSha256":hash,"manifest":{"schema":2,"id":id,"compatibility":"native-v1","sequence":2}});
        if resource == ArtifactResource::Pi {
            artifact["sourceRelease"] = json!(SOURCE_RELEASE);
            artifact["updateScope"] = json!("pi-only");
        }
        artifact
    }

    fn installed_fixture() -> Value {
        json!({"releaseId":SOURCE_RELEASE,"manifest":{"id":SOURCE_RELEASE,"schema":2,"compatibility":"native-v1","sequence":1}})
    }

    fn pins_fixture() -> Value {
        json!({"releaseId":SOURCE_RELEASE,"runtimePinsSha256":"b".repeat(64)})
    }

    #[test]
    fn release_check_serializes_the_public_outcomes() {
        for (outcome, expected) in [
            (CheckOutcome::UpdateAvailable, "update_available"),
            (CheckOutcome::UpToDate, "up_to_date"),
            (CheckOutcome::Blocked, "blocked"),
        ] {
            assert_eq!(serde_json::to_value(outcome).unwrap(), json!(expected));
        }
    }

    #[test]
    fn release_check_update_available_does_not_require_a_pi_version_change() {
        let mut installed = installed_fixture();
        let mut host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        installed["manifest"]["piVersion"] = json!("1.0.0");
        host["manifest"]["piVersion"] = json!("1.0.0");
        let (outcome, _) = release_check(&installed, ArtifactResource::Host, &host, true, true);
        assert_eq!(outcome, CheckOutcome::UpdateAvailable);
        assert!(newer_artifact(&installed, &host));
    }

    #[test]
    fn release_check_up_to_date_requires_an_exact_compatible_release() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        let installed = json!({"releaseId":host["id"],"manifest":host["manifest"]});
        let probe = json!({"releaseId":host["id"],"runtimePinsSha256":host["runtimePinsSha256"]});
        let (resource, artifact) = select_artifact(&installed, &probe, &host, None)
            .unwrap()
            .unwrap();
        let (outcome, _) = release_check(&installed, resource, artifact, true, true);
        assert_eq!(outcome, CheckOutcome::UpToDate);
        assert!(!newer_artifact(&installed, artifact));
    }

    #[test]
    fn release_check_blocks_non_native_or_unpinned_installations() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        for (field, value) in [("schema", json!(1)), ("compatibility", json!("legacy"))] {
            let mut installed = installed_fixture();
            installed["manifest"][field] = value;
            let (outcome, message) =
                release_check(&installed, ArtifactResource::Host, &host, true, false);
            assert_eq!(outcome, CheckOutcome::Blocked);
            assert!(message.contains("qualify a supported installation"));
        }
        let (outcome, message) = release_check(
            &installed_fixture(),
            ArtifactResource::Host,
            &host,
            false,
            false,
        );
        assert_eq!(outcome, CheckOutcome::Blocked);
        assert!(message.contains("pinned SSH connection"));
    }

    #[test]
    fn release_check_blocks_incompatible_bundles_even_with_matching_identity() {
        let host = artifact_fixture(ArtifactResource::Host, &"c".repeat(64));
        let installed = json!({"releaseId":host["id"],"manifest":host["manifest"]});
        let probe = json!({"releaseId":host["id"],"runtimePinsSha256":"b".repeat(64)});
        let selected = select_artifact(&installed, &probe, &host, None).unwrap();
        assert!(selected.is_none());
        let (outcome, message) = release_check(
            &installed,
            ArtifactResource::Host,
            &host,
            true,
            selected.is_some(),
        );
        assert_eq!(outcome, CheckOutcome::Blocked);
        assert!(message.contains("qualified for this runtime family"));
    }

    #[test]
    fn release_check_blocks_equal_sequences_with_different_identity_or_content() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        let exact = json!({"releaseId":host["id"],"manifest":host["manifest"]});
        let mut different_id = exact.clone();
        different_id["releaseId"] = json!(SOURCE_RELEASE);
        different_id["manifest"]["id"] = json!(SOURCE_RELEASE);
        let mut different_content = exact.clone();
        different_content["manifest"]["piVersion"] = json!("different");
        let mut unbound_id = exact;
        unbound_id["releaseId"] = json!(SOURCE_RELEASE);
        for installed in [different_id, different_content, unbound_id] {
            let (outcome, message) =
                release_check(&installed, ArtifactResource::Host, &host, true, true);
            assert_eq!(outcome, CheckOutcome::Blocked);
            assert!(message.contains("same sequence but different"));
        }
    }

    #[test]
    fn release_check_blocks_downgrades_reused_ids_and_invalid_sequences() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        let mut newer = installed_fixture();
        newer["manifest"]["sequence"] = json!(3);
        let (outcome, message) = release_check(&newer, ArtifactResource::Host, &host, true, true);
        assert_eq!(outcome, CheckOutcome::Blocked);
        assert!(message.contains("downgrades are blocked"));

        let mut reused_id = installed_fixture();
        reused_id["releaseId"] = host["id"].clone();
        reused_id["manifest"]["id"] = host["id"].clone();
        assert_eq!(
            release_check(&reused_id, ArtifactResource::Host, &host, true, true).0,
            CheckOutcome::Blocked
        );
        for sequence in [Value::Null, json!("2"), json!(-1)] {
            let mut invalid = host.clone();
            invalid["manifest"]["sequence"] = sequence;
            let installed = json!({"releaseId":invalid["id"],"manifest":invalid["manifest"]});
            assert_eq!(
                release_check(&installed, ArtifactResource::Host, &invalid, true, true).0,
                CheckOutcome::Blocked
            );
        }
    }

    #[test]
    fn release_check_preserves_existing_availability_admission() {
        for source_schema in [1, 2] {
            for target_schema in [1, 2] {
                for pinned_ssh in [false, true] {
                    for compatible in [false, true] {
                        for sequence in [0, 1, 2, 3] {
                            for same_id in [false, true] {
                                let mut installed = installed_fixture();
                                let mut host =
                                    artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
                                installed["manifest"]["schema"] = json!(source_schema);
                                installed["manifest"]["sequence"] = json!(sequence);
                                host["manifest"]["schema"] = json!(target_schema);
                                if same_id {
                                    installed["releaseId"] = host["id"].clone();
                                    installed["manifest"]["id"] = host["id"].clone();
                                }
                                let available = pinned_ssh
                                    && source_schema == 2
                                    && target_schema == 2
                                    && compatible
                                    && newer_artifact(&installed, &host);
                                let (outcome, _) = release_check(
                                    &installed,
                                    ArtifactResource::Host,
                                    &host,
                                    pinned_ssh,
                                    compatible,
                                );
                                assert_eq!(outcome == CheckOutcome::UpdateAvailable, available);
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn artifact_selection_prefers_pi_only_for_matching_source_and_pins() {
        let pi = artifact_fixture(ArtifactResource::Pi, &"b".repeat(64));
        for host_hash in ["b".repeat(64), "c".repeat(64)] {
            let host = artifact_fixture(ArtifactResource::Host, &host_hash);
            let (resource, artifact) =
                select_artifact(&installed_fixture(), &pins_fixture(), &host, Some(&pi))
                    .unwrap()
                    .unwrap();
            assert_eq!(resource, ArtifactResource::Pi);
            assert_eq!(artifact, &pi);
        }
    }

    #[test]
    fn wrong_pi_source_or_pins_never_falls_back_to_a_browser_runtime_mismatch() {
        for (key, value) in [
            ("sourceRelease", json!("host-33333333333333333333")),
            ("runtimePinsSha256", json!("d".repeat(64))),
        ] {
            let mut pi = artifact_fixture(ArtifactResource::Pi, &"b".repeat(64));
            pi[key] = value;
            let incompatible_host = artifact_fixture(ArtifactResource::Host, &"c".repeat(64));
            assert!(select_artifact(
                &installed_fixture(),
                &pins_fixture(),
                &incompatible_host,
                Some(&pi)
            )
            .unwrap()
            .is_none());
            let compatible_host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
            assert_eq!(
                select_artifact(
                    &installed_fixture(),
                    &pins_fixture(),
                    &compatible_host,
                    Some(&pi)
                )
                .unwrap(),
                Some((ArtifactResource::Host, &compatible_host))
            );
        }
    }

    #[test]
    fn missing_pi_artifact_only_allows_a_pin_compatible_main_artifact() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        assert_eq!(
            select_artifact(&installed_fixture(), &pins_fixture(), &host, None).unwrap(),
            Some((ArtifactResource::Host, &host))
        );
        let host = artifact_fixture(ArtifactResource::Host, &"c".repeat(64));
        assert!(
            select_artifact(&installed_fixture(), &pins_fixture(), &host, None)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn artifact_selection_requires_probe_to_match_signed_source_identity() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        for (key, value) in [
            ("releaseId", Value::Null),
            ("releaseId", json!("host-33333333333333333333")),
            ("runtimePinsSha256", Value::Null),
            ("runtimePinsSha256", json!("not-a-hash")),
        ] {
            let mut probe = pins_fixture();
            probe[key] = value;
            assert!(select_artifact(&installed_fixture(), &probe, &host, None).is_err());
        }
        let mut installed = installed_fixture();
        installed["manifest"]["id"] = json!("host-33333333333333333333");
        assert!(select_artifact(&installed, &pins_fixture(), &host, None).is_err());
    }

    #[test]
    fn malformed_optional_artifact_blocks_even_a_matching_main_artifact() {
        let host = artifact_fixture(ArtifactResource::Host, &"b".repeat(64));
        for (key, value) in [
            ("schema", json!(2)),
            ("sourceRelease", Value::Null),
            ("updateScope", json!("full")),
            ("runtimePinsSha256", Value::Null),
            ("runtimePinsSha256", json!("b".repeat(63))),
            ("sha256", json!("G".repeat(64))),
            ("size", json!(0)),
            ("manifest", json!({})),
        ] {
            let mut pi = artifact_fixture(ArtifactResource::Pi, &"b".repeat(64));
            pi[key] = value;
            assert!(
                select_artifact(&installed_fixture(), &pins_fixture(), &host, Some(&pi)).is_err()
            );
        }
    }

    #[test]
    fn optional_artifact_loading_distinguishes_absence_from_invalid_files() {
        let root = std::env::temp_dir().join(format!("outpost-update-artifact-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("pi-release.json");
        assert_eq!(read_artifact(&path, ArtifactResource::Pi).unwrap(), None);
        fs::write(&path, b"not JSON").unwrap();
        assert!(read_artifact(&path, ArtifactResource::Pi).is_err());
        fs::write(&path, b"{}").unwrap();
        assert!(read_artifact(&path, ArtifactResource::Pi).is_err());
        let pi = artifact_fixture(ArtifactResource::Pi, &"b".repeat(64));
        fs::write(&path, serde_json::to_vec(&pi).unwrap()).unwrap();
        assert_eq!(
            read_artifact(&path, ArtifactResource::Pi).unwrap(),
            Some(pi)
        );
        fs::remove_file(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(read_artifact(&path, ArtifactResource::Pi).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reviewed_archive_is_whitelisted_and_legacy_reviews_default_to_host() {
        let mut review = json!({"installed":installed_fixture(),"artifact":artifact_fixture(ArtifactResource::Pi, &"b".repeat(64))});
        assert_eq!(review_archive(&review).unwrap(), "host-release.tar.gz");
        review["artifactResource"] = json!("host-release");
        assert_eq!(review_archive(&review).unwrap(), "host-release.tar.gz");
        review["artifactResource"] = json!("pi-release");
        assert_eq!(review_archive(&review).unwrap(), "pi-release.tar.gz");
        for name in [
            Value::Null,
            json!(42),
            json!("../pi-release"),
            json!("/tmp/host-release"),
            json!("pi-release.tar.gz"),
            json!("$(touch unwanted)"),
        ] {
            review["artifactResource"] = name;
            assert!(review_archive(&review).is_err());
        }
        review["artifactResource"] = json!("pi-release");
        review["artifact"]["sourceRelease"] = json!("host-33333333333333333333");
        assert!(review_archive(&review).is_err());
        review["artifact"]["sourceRelease"] = json!(SOURCE_RELEASE);
        review["artifact"]["updateScope"] = json!("full");
        assert!(review_archive(&review).is_err());
        review["artifact"]["updateScope"] = json!("pi-only");
        review["installed"]["releaseId"] = Value::Null;
        review["artifact"]["sourceRelease"] = Value::Null;
        assert!(review_archive(&review).is_err());
    }

    #[test]
    fn active_and_unknown_reviews_are_retained_before_any_check() {
        for state in [
            "unknown",
            "authorizing",
            "queued",
            "staging",
            "waiting_for_idle",
            "activating",
            "recovering",
            "needs_attention",
            "unrecognized",
        ] {
            assert!(retain_previous_review(&json!({"state":state})));
        }
        assert!(retain_previous_review(&json!({})));
        for state in ["review", "complete", "failed", "rolled_back", "cancelled"] {
            assert!(!retain_previous_review(&json!({"state":state})));
        }
    }

    #[cfg(unix)]
    #[test]
    fn runtime_pins_probe_reads_only_confined_public_metadata() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("outpost-update-probe-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let root = fs::canonicalize(root).unwrap();
        let prefix = root.join("native");
        let release = prefix.join("releases").join(SOURCE_RELEASE);
        fs::create_dir_all(release.join("deploy/environment")).unwrap();
        fs::write(
            release.join("host-manifest.json"),
            serde_json::to_vec(&json!({"id":SOURCE_RELEASE})).unwrap(),
        )
        .unwrap();
        let pins = release.join("deploy/environment/runtime-pins.json");
        let bytes = b"{\"public\":\"static pins\"}\n";
        fs::write(&pins, bytes).unwrap();
        let current = prefix.join("current");
        symlink(&release, &current).unwrap();
        let source = RUNTIME_PINS_PROBE.replace(
            "pathlib.Path('/opt/outpost-native')",
            &format!(
                "pathlib.Path({})",
                serde_json::to_string(prefix.to_str().unwrap()).unwrap()
            ),
        );
        let probe = || {
            Command::new("/usr/bin/python3")
                .args(["-c", &source])
                .output()
                .unwrap()
        };
        let output = probe();
        assert!(output.status.success());
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(
            result,
            json!({"releaseId":SOURCE_RELEASE,"runtimePinsSha256":format!("{:x}", Sha256::digest(bytes))})
        );

        // Even a matching release ID outside the native prefix cannot authorize an update.
        let outside = root.join(SOURCE_RELEASE);
        fs::rename(&release, &outside).unwrap();
        fs::remove_file(&current).unwrap();
        symlink(&outside, &current).unwrap();
        let output = probe();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        fs::remove_file(&current).unwrap();
        fs::rename(&outside, &release).unwrap();
        symlink(&release, &current).unwrap();

        // Public metadata itself must not be redirected to files outside the release.
        let redirected = root.join("other-pins.json");
        fs::rename(&pins, &redirected).unwrap();
        symlink(&redirected, &pins).unwrap();
        let output = probe();
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        fs::remove_file(&pins).unwrap();
        fs::rename(&redirected, &pins).unwrap();
        fs::write(
            release.join("host-manifest.json"),
            b"{\"id\":\"host-33333333333333333333\"}",
        )
        .unwrap();
        assert!(!probe().status.success());
        fs::remove_dir_all(root).unwrap();
    }

    fn run_fixture_bootstrap(installer: &str, updater: &str) -> Vec<u8> {
        let source = bootstrap_source(installer, updater, OPERATION, ENVIRONMENT).unwrap();
        let output = Command::new("/bin/sh")
            .args(["-c", &format!("{} --bootstrap", python(&source))])
            .stdin(Stdio::null())
            .output()
            .expect("Local Python bootstrap fixture must execute");
        assert!(
            output.status.success(),
            "Handled bootstrap errors must exit zero"
        );
        assert!(
            output.stderr.is_empty(),
            "Bootstrap must not emit a traceback or raw error"
        );
        output.stdout
    }

    #[test]
    fn bootstrap_exceptions_emit_only_bound_safe_unknown_diagnostics() {
        for (exception, expected) in [
            (
                "json.JSONDecodeError('RAW_CANARY_password', 'RAW_CANARY_frame', 0)",
                "invalid_launch_frame",
            ),
            (
                "ValueError('RAW_CANARY_password_frame')",
                "invalid_release_packet",
            ),
            ("OSError('RAW_CANARY_password_frame')", "launcher_io_failed"),
            (
                "PermissionError('RAW_CANARY_password_frame')",
                "launcher_io_failed",
            ),
            (
                "RuntimeError('RAW_CANARY_password_frame')",
                "launcher_failed",
            ),
        ] {
            let failing = format!("import json\nraise {exception}\n");
            for (installer, updater) in [("", failing.as_str()), (failing.as_str(), "")] {
                let bytes = run_fixture_bootstrap(installer, updater);
                assert!(!String::from_utf8_lossy(&bytes).contains("RAW_CANARY"));
                let reply: Value = serde_json::from_slice(&bytes).unwrap();
                assert_eq!(reply.as_object().unwrap().len(), 5);
                assert_eq!(reply["operationId"], OPERATION);
                assert_eq!(reply["environmentId"], ENVIRONMENT);
                assert_eq!(reply["state"], "unknown");
                assert_eq!(reply["launchError"], expected);
                assert!(reply["stage"]
                    .as_str()
                    .unwrap()
                    .contains("Launch outcome remains unknown; check status."));
            }
        }
    }

    #[test]
    fn bootstrap_success_receipt_passes_through_unchanged() {
        let receipt = json!({"operationId":OPERATION,"environmentId":ENVIRONMENT,"state":"queued","stage":"Verified release received","updatedAt":123}).to_string() + "\n";
        let updater = format!(
            "import sys\nfrom common import marker\nassert marker == 'fixture'\nassert __name__ == '__main__'\nassert sys.argv[1:] == ['--bootstrap']\nsys.stdout.write({})\n",
            serde_json::to_string(&receipt).unwrap()
        );
        let bytes = run_fixture_bootstrap(
            "assert __name__ == 'common'\nmarker = 'fixture'\n",
            &updater,
        );
        assert_eq!(bytes, receipt.as_bytes());
    }

    #[test]
    fn production_bootstrap_command_stays_below_argument_limit() {
        let source = bootstrap_source(COMMON, UPDATER, OPERATION, ENVIRONMENT).unwrap();
        let encoded_source = STANDARD.encode(source);
        assert!(
            encoded_source.len() <= 1048576,
            "Bundled bootstrap exceeds the stdin loader's input bound"
        );
        for (root, password, prefix) in [
            (false, true, "sudo -k -S -p '' -- "),
            (false, false, "sudo -n -- "),
            (true, true, ""),
            (true, false, ""),
        ] {
            let command = manual_bootstrap_command(root, password);
            println!(
                "Production bootstrap command (root={root}, password={password}): {} bytes",
                command.len()
            );
            assert!(
                command.len() < 131072,
                "Bootstrap command exceeds the single-argument budget: {} bytes",
                command.len()
            );
            assert!(
                command.len() < 4096,
                "Only the fixed stdin loader belongs in the SSH command"
            );
            assert!(command.starts_with(&format!("{prefix}/usr/bin/python3 -I -c ")));
            assert!(command.ends_with(" --bootstrap"));
            assert!(command.contains(&STANDARD.encode(automatic::BOOTSTRAP_LOADER)));
            assert!(
                !command.contains(&encoded_source),
                "Bundled modules must be sent on stdin, not in argv"
            );
        }
    }

    #[test]
    fn bootstrap_source_rejects_invalid_diagnostic_bindings() {
        for invalid in ["", "not-a-uuid", "');print('unbound')#"] {
            assert!(bootstrap_source("", "", invalid, ENVIRONMENT).is_err());
            assert!(bootstrap_source("", "", OPERATION, invalid).is_err());
        }
    }

    #[test]
    fn missing_receipt_preserves_bootstrap_cause_until_bound_host_progress_arrives() {
        let bytes = run_fixture_bootstrap("", "raise ValueError('RAW_CANARY_password_frame')");
        let diagnostic: Value = serde_json::from_slice(&bytes).unwrap();
        let mut review =
            json!({"operationId":OPERATION,"environmentId":ENVIRONMENT,"state":"unknown"});
        apply_launch_result(&mut review, ENVIRONMENT, Ok(bytes));
        assert_eq!(review["progress"], diagnostic);
        for _ in 0..2 {
            apply_host_status(&mut review, json!({"state":"unknown"}), ENVIRONMENT);
            assert_eq!(review["state"], "unknown");
            assert_eq!(review["progress"]["launchError"], diagnostic["launchError"]);
            assert_eq!(review["progress"]["stage"], diagnostic["stage"]);
            assert!(review["progress"]["receiptNote"]
                .as_str()
                .unwrap()
                .contains("No host update receipt"));
        }
        let receipt = json!({"operationId":OPERATION,"environmentId":ENVIRONMENT,"state":"queued","stage":"Verified release received"});
        apply_host_status(&mut review, receipt.clone(), ENVIRONMENT);
        assert_eq!(review["state"], "queued");
        assert_eq!(review["progress"], receipt);
    }

    #[test]
    fn update_leases_serialize_each_server_and_release_after_errors() {
        let a = Uuid::new_v4().to_string();
        let b = Uuid::new_v4().to_string();
        let first = acquire(&a).unwrap();
        assert!(acquire(&a).is_err());
        let independent = acquire(&b).unwrap();
        drop(first);
        assert!(acquire(&a).is_ok());
        drop(independent);
    }

    fn unknown_review() -> Value {
        json!({"operationId":"operation-a","environmentId":"environment-a","state":"unknown"})
    }

    fn cancelled_reply() -> Value {
        json!({"operationId":"operation-a","owner":"device-a","state":"cancelled"})
    }

    fn explicit_cancel_review() -> Value {
        let mut review = unknown_review();
        review["cancellationIntent"] = json!({
            "operationId":"operation-a", "environmentId":"environment-a", "owner":"device-a"
        });
        review
    }

    fn failed_host_receipt() -> Value {
        json!({"operationId":"operation-a","environmentId":"environment-a","state":"failed",
            "stage":"Update stopped before activation; previous release remains active",
            "error":"preflight_failed"})
    }

    #[test]
    fn cancellation_requires_matching_operation_owner_and_cancelled_state() {
        let mut review = explicit_cancel_review();
        assert!(reconcile_cancelled(
            &mut review,
            &cancelled_reply(),
            "device-a"
        ));
        assert_eq!(review["state"], "cancelled");

        for (key, value) in [
            ("operationId", json!("operation-b")),
            ("operationId", Value::Null),
            ("owner", json!("device-b")),
            ("owner", Value::Null),
            ("state", json!("staging")),
            ("state", json!("prepared")),
            ("state", Value::Null),
        ] {
            let mut reply = cancelled_reply();
            reply[key] = value;
            let mut review = explicit_cancel_review();
            let before = review.clone();
            assert!(!reconcile_cancelled(&mut review, &reply, "device-a"));
            assert_eq!(review, before);
        }
    }

    #[test]
    fn cancellation_rejects_missing_or_empty_identity_bindings() {
        for operation in [Value::Null, json!(""), json!(42)] {
            let mut review = explicit_cancel_review();
            review["operationId"] = operation.clone();
            let mut reply = cancelled_reply();
            reply["operationId"] = operation;
            let before = review.clone();
            assert!(!reconcile_cancelled(&mut review, &reply, "device-a"));
            assert_eq!(review, before);
        }
        let mut review = explicit_cancel_review();
        let mut reply = cancelled_reply();
        reply["owner"] = json!("");
        assert!(!reconcile_cancelled(&mut review, &reply, ""));
        assert_eq!(review["state"], "unknown");
    }

    #[test]
    fn unknown_is_cancel_eligible_but_needs_attention_and_invalid_states_are_not() {
        for state in [
            "authorizing",
            "queued",
            "staging",
            "waiting_for_idle",
            "unknown",
        ] {
            assert!(can_cancel(&json!(state)));
        }
        for state in [
            "needs_attention",
            "activating",
            "recovering",
            "complete",
            "rolled_back",
            "failed",
            "cancelled",
            "review",
            "unexpected",
        ] {
            assert!(!can_cancel(&json!(state)));
        }
        assert!(!can_cancel(&Value::Null));
        assert!(!can_cancel(&json!(42)));
    }

    #[test]
    fn coordinator_staging_does_not_become_host_progress() {
        let mut review = unknown_review();
        let before = review.clone();
        let mut reply = cancelled_reply();
        reply["state"] = json!("staging");
        assert!(!reconcile_cancelled(&mut review, &reply, "device-a"));
        assert_eq!(review, before);
    }

    #[test]
    fn missing_host_receipt_retains_unknown_and_explains_guarded_cancellation() {
        let mut review = unknown_review();
        apply_host_status(&mut review, json!({"state":"unknown"}), "environment-a");
        assert_eq!(review["state"], "unknown");
        assert_eq!(review["operationId"], "operation-a");
        let stage = review["progress"]["stage"].as_str().unwrap();
        assert!(stage.contains("No host update receipt"));
        assert!(stage.contains("Server-guarded cancellation"));
        assert!(stage.contains("No launch will be retried automatically"));
    }

    #[test]
    fn missing_host_receipt_does_not_replace_known_host_progress() {
        let mut review = unknown_review();
        review["state"] = json!("activating");
        review["progress"] =
            json!({"stage":"Activating the reviewed release","state":"activating"});
        let before = review.clone();
        apply_host_status(&mut review, json!({"state":"unknown"}), "environment-a");
        assert_eq!(review, before);
    }

    #[test]
    fn host_receipt_requires_binding_and_known_host_state() {
        let receipt = json!({"operationId":"operation-a","environmentId":"environment-a","state":"queued","stage":"Verified release received"});
        let mut review = unknown_review();
        assert!(apply_host_receipt(
            &mut review,
            receipt.clone(),
            "environment-a"
        ));
        assert_eq!(review["state"], "queued");
        assert_eq!(review["progress"], receipt);

        for (key, value) in [
            ("operationId", json!("operation-b")),
            ("operationId", Value::Null),
            ("environmentId", json!("environment-b")),
            ("environmentId", Value::Null),
            ("state", json!("cancelled")),
            ("state", json!("authorizing")),
            ("state", json!("unexpected")),
            ("state", Value::Null),
        ] {
            let mut status = receipt.clone();
            status[key] = value;
            let mut review = unknown_review();
            let before = review.clone();
            apply_host_status(&mut review, status, "environment-a");
            assert_eq!(review, before);
        }
    }

    #[test]
    fn lost_cancel_reply_can_reconcile_without_a_host_receipt() {
        let mut review = explicit_cancel_review();
        apply_host_status(&mut review, json!({"state":"unknown"}), "environment-a");
        assert!(can_cancel(&review["state"]));
        assert!(reconcile_cancelled(
            &mut review,
            &cancelled_reply(),
            "device-a"
        ));
        assert_eq!(review["state"], "cancelled");
    }

    #[test]
    fn coordinator_cleanup_without_explicit_intent_is_not_user_cancellation() {
        for intent in [
            Value::Null,
            json!(true),
            json!({"operationId":"operation-b","environmentId":"environment-a","owner":"device-a"}),
            json!({"operationId":"operation-a","environmentId":"environment-b","owner":"device-a"}),
            json!({"operationId":"operation-a","environmentId":"environment-a","owner":"device-b"}),
            json!({"operationId":"operation-a","environmentId":"environment-a","owner":""}),
        ] {
            let mut review = unknown_review();
            review["cancellationIntent"] = intent;
            let before = review.clone();
            assert!(!reconcile_cancelled(
                &mut review,
                &cancelled_reply(),
                "device-a"
            ));
            assert_eq!(review, before);
        }
    }

    #[test]
    fn failed_host_receipt_takes_precedence_over_coordinator_cleanup() {
        let receipt = failed_host_receipt();
        for state in ["unknown", "staging", "cancelled"] {
            let mut review = unknown_review();
            review["state"] = json!(state);
            reconcile_status(
                &mut review,
                "environment-a",
                Ok(receipt.clone()),
                Some((&cancelled_reply(), "device-a")),
            )
            .unwrap();
            assert_eq!(review["state"], "failed");
            assert_eq!(review["progress"], receipt);
            // A subsequent missing/unreachable receipt must not erase the known failure.
            for host in [
                Ok(json!({"state":"unknown"})),
                Err("SSH unavailable".into()),
            ] {
                reconcile_status(
                    &mut review,
                    "environment-a",
                    host,
                    Some((&cancelled_reply(), "device-a")),
                )
                .unwrap();
                assert_eq!(review["state"], "failed");
                assert_eq!(review["progress"], receipt);
            }
        }
    }

    #[test]
    fn persisted_cancelled_without_intent_rechecks_host_receipt() {
        let old = json!({"operationId":"operation-a","environmentId":"environment-a",
            "state":"cancelled","progress":{"stage":"Server confirmed cancellation before activation."}});
        let mut review: Value = serde_json::from_slice(&serde_json::to_vec(&old).unwrap()).unwrap();
        assert!(needs_host_status(&review));
        reconcile_status(
            &mut review,
            "environment-a",
            Ok(failed_host_receipt()),
            None,
        )
        .unwrap();
        assert_eq!(review["state"], "failed");
        assert_eq!(review["progress"], failed_host_receipt());
    }

    #[test]
    fn legacy_cancellation_without_intent_does_not_survive_an_unreachable_host() {
        let mut review = unknown_review();
        review["state"] = json!("cancelled");
        reconcile_status(
            &mut review,
            "environment-a",
            Err("SSH unavailable".into()),
            None,
        )
        .unwrap();
        assert_eq!(review["state"], "unknown");
        assert!(review["progress"]["stage"]
            .as_str()
            .unwrap()
            .contains("no verified host outcome"));

        review["state"] = json!("cancelled");
        review["progress"] = failed_host_receipt();
        reconcile_status(
            &mut review,
            "environment-a",
            Err("SSH unavailable".into()),
            None,
        )
        .unwrap();
        assert_eq!(review["state"], "failed");
        assert_eq!(review["progress"], failed_host_receipt());
    }

    #[test]
    fn aborted_reservation_without_host_evidence_is_unknown_not_user_cancelled() {
        for state in ["authorizing", "unknown", "cancelled"] {
            for host in [
                Ok(json!({"state":"unknown"})),
                Err("SSH unavailable".into()),
                Ok(
                    json!({"operationId":"operation-b","environmentId":"environment-a","state":"failed"}),
                ),
            ] {
                let mut review = unknown_review();
                review["state"] = json!(state);
                reconcile_status(
                    &mut review,
                    "environment-a",
                    host,
                    Some((&cancelled_reply(), "device-a")),
                )
                .unwrap();
                assert_eq!(review["state"], "unknown");
                let stage = review["progress"]["stage"].as_str().unwrap();
                assert!(stage.contains("reservation was aborted"));
                assert!(stage.contains("user cancellation is not confirmed"));
                assert!(stage.contains("No launch will be retried automatically"));
            }
        }
    }

    #[test]
    fn intent_alone_does_not_confirm_cancellation_when_transports_fail() {
        let mut review = explicit_cancel_review();
        assert!(reconcile_status(
            &mut review,
            "environment-a",
            Err("SSH unavailable".into()),
            None
        )
        .is_err());
        assert_eq!(review["state"], "unknown");
    }

    #[test]
    fn explicit_cancellation_survives_lost_reply_and_unreachable_host() {
        let mut review = explicit_cancel_review();
        reconcile_status(
            &mut review,
            "environment-a",
            Err("SSH unavailable".into()),
            Some((&cancelled_reply(), "device-a")),
        )
        .unwrap();
        assert_eq!(review["state"], "cancelled");
        assert!(review["cancellationConfirmed"].is_null());
        assert!(needs_host_status(&review));
        let confirmed = review.clone();
        reconcile_status(
            &mut review,
            "environment-a",
            Err("SSH unavailable".into()),
            None,
        )
        .unwrap();
        assert_eq!(review, confirmed);
    }

    #[test]
    fn acknowledged_cancellation_keeps_later_host_cleanup_failure_diagnostics() {
        let mut review = explicit_cancel_review();
        apply_cancel_reply(&mut review, Ok(cancelled_reply()), "device-a").unwrap();
        assert!(cancellation_confirmed(&review));
        // Confirmation remains binding-specific across persistence/restart.
        let mut review: Value =
            serde_json::from_slice(&serde_json::to_vec(&review).unwrap()).unwrap();
        assert!(cancellation_confirmed(&review));
        reconcile_status(
            &mut review,
            "environment-a",
            Ok(failed_host_receipt()),
            Some((&cancelled_reply(), "device-a")),
        )
        .unwrap();
        assert_eq!(review["state"], "cancelled");
        assert_eq!(review["progress"]["state"], "failed");
        assert_eq!(review["progress"]["error"], "preflight_failed");
        assert_eq!(review["progress"]["stage"], failed_host_receipt()["stage"]);
        assert!(review["progress"]["cancellationNote"].is_string());
        assert!(needs_host_status(&review));
        reconcile_status(
            &mut review,
            "environment-a",
            Ok(failed_host_receipt()),
            None,
        )
        .unwrap();
        assert_eq!(review["state"], "cancelled");
        assert_eq!(review["progress"], failed_host_receipt());
    }

    #[test]
    fn rejected_cancel_after_host_failure_and_cleanup_remains_failed() {
        // The local review is stale: the host already failed and aborted its reservation.
        let mut review = explicit_cancel_review();
        let intent = review["cancellationIntent"].clone();
        assert!(apply_cancel_reply(
            &mut review,
            Err("maintenance_cannot_cancel".into()),
            "device-a"
        )
        .is_err());
        assert_eq!(review["cancellationIntent"], intent);
        assert!(review["cancellationConfirmed"].is_null());
        reconcile_status(
            &mut review,
            "environment-a",
            Ok(failed_host_receipt()),
            Some((&cancelled_reply(), "device-a")),
        )
        .unwrap();
        assert_eq!(review["state"], "failed");
        assert_eq!(review["progress"], failed_host_receipt());
        assert_eq!(review["cancellationIntent"], intent);
        assert!(!cancellation_confirmed(&review));
        assert!(!reconcile_cancelled(
            &mut review,
            &cancelled_reply(),
            "device-a"
        ));
    }

    #[test]
    fn lost_cancel_ack_cannot_override_current_or_later_host_failure() {
        for infer_before_receipt in [false, true] {
            let mut review = explicit_cancel_review();
            let intent = review["cancellationIntent"].clone();
            assert!(apply_cancel_reply(&mut review, Err("Reply lost".into()), "device-a").is_err());
            if infer_before_receipt {
                reconcile_status(
                    &mut review,
                    "environment-a",
                    Err("SSH unavailable".into()),
                    Some((&cancelled_reply(), "device-a")),
                )
                .unwrap();
                assert_eq!(review["state"], "cancelled");
            }
            assert!(review["cancellationConfirmed"].is_null());
            reconcile_status(
                &mut review,
                "environment-a",
                Ok(failed_host_receipt()),
                Some((&cancelled_reply(), "device-a")),
            )
            .unwrap();
            assert_eq!(review["state"], "failed");
            assert_eq!(review["progress"], failed_host_receipt());
            assert_eq!(review["cancellationIntent"], intent);
            assert!(review["cancellationConfirmed"].is_null());

            // Previously misclassified persisted receipts also retain their known host error offline.
            review["state"] = json!("cancelled");
            review["progress"]["cancellationNote"] =
                json!("Server confirmed the requested cancellation before activation.");
            reconcile_status(
                &mut review,
                "environment-a",
                Err("SSH unavailable".into()),
                None,
            )
            .unwrap();
            assert_eq!(review["state"], "failed");
            assert_eq!(review["progress"], failed_host_receipt());
            assert_eq!(review["cancellationIntent"], intent);
        }
    }

    #[test]
    fn direct_cancellation_ack_requires_valid_reply_and_intent_bindings() {
        for (key, value) in [
            ("operationId", json!("operation-b")),
            ("owner", json!("device-b")),
            ("state", json!("failed")),
            ("state", Value::Null),
        ] {
            let mut review = explicit_cancel_review();
            let before = review.clone();
            let mut reply = cancelled_reply();
            reply[key] = value;
            assert!(apply_cancel_reply(&mut review, Ok(reply), "device-a").is_err());
            assert_eq!(review, before);
        }
        let mut review = unknown_review();
        assert!(apply_cancel_reply(&mut review, Ok(cancelled_reply()), "device-a").is_err());
        assert!(review["cancellationConfirmed"].is_null());

        for (key, value) in [
            ("operationId", json!("operation-b")),
            ("environmentId", json!("environment-b")),
            ("owner", json!("device-b")),
            ("owner", Value::Null),
        ] {
            let mut review = explicit_cancel_review();
            apply_cancel_reply(&mut review, Ok(cancelled_reply()), "device-a").unwrap();
            review["cancellationConfirmed"][key] = value;
            assert!(!cancellation_confirmed(&review));
            reconcile_status(
                &mut review,
                "environment-a",
                Ok(failed_host_receipt()),
                Some((&cancelled_reply(), "device-a")),
            )
            .unwrap();
            assert_eq!(review["state"], "failed");
            assert_eq!(review["progress"], failed_host_receipt());
        }
    }

    #[test]
    fn unrelated_operation_cancellation_cannot_affect_a_fresh_review() {
        let mut review = unknown_review();
        review["operationId"] = json!("operation-new");
        assert!(review["cancellationIntent"].is_null());
        let before = review.clone();
        assert!(reconcile_status(
            &mut review,
            "environment-a",
            Err("SSH unavailable".into()),
            Some((&cancelled_reply(), "device-a"))
        )
        .is_err());
        assert_eq!(review, before);
        // Even an accidentally carried old intent cannot bind to the new operation.
        review["cancellationIntent"] = explicit_cancel_review()["cancellationIntent"].clone();
        assert!(cancellation_intent_owner(&review).is_none());
        let reply = json!({"operationId":"operation-new","owner":"device-a","state":"cancelled"});
        reconcile_status(
            &mut review,
            "environment-a",
            Ok(failed_host_receipt()),
            Some((&reply, "device-a")),
        )
        .unwrap();
        assert_eq!(review["state"], "unknown");
        assert!(review["progress"]["error"].is_null());
    }

    #[test]
    fn cancellation_intent_is_durable_before_any_remote_confirmation() {
        let root = std::env::temp_dir().join(format!("outpost-update-intent-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let setup = Setup::new(root.clone()).unwrap();
        let mut review =
            json!({"operationId":OPERATION,"environmentId":ENVIRONMENT,"state":"unknown"});
        save_cancellation_intent(&setup, ENVIRONMENT, &mut review, "device-a").unwrap();
        let mut persisted = load(&setup, ENVIRONMENT).unwrap();
        assert_eq!(persisted["state"], "unknown");
        assert_eq!(cancellation_intent_owner(&persisted), Some("device-a"));
        let reply = json!({"operationId":OPERATION,"owner":"device-a","state":"cancelled"});
        reconcile_status(
            &mut persisted,
            ENVIRONMENT,
            Err("SSH unavailable".into()),
            Some((&reply, "device-a")),
        )
        .unwrap();
        assert_eq!(persisted["state"], "cancelled");
        assert!(persisted["cancellationConfirmed"].is_null());
        apply_cancel_reply(&mut persisted, Ok(reply), "device-a").unwrap();
        save(&setup, ENVIRONMENT, &persisted).unwrap();
        assert!(cancellation_confirmed(&load(&setup, ENVIRONMENT).unwrap()));
        assert!(save_cancellation_intent(&setup, OPERATION, &mut review, "device-a").is_err());
        drop(setup);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn launch_failure_records_only_a_safe_generic_stage_and_retains_unknown() {
        let mut review = unknown_review();
        apply_launch_result(
            &mut review,
            "environment-a",
            Err("sensitive SSH command output".into()),
        );
        assert_eq!(review["state"], "unknown");
        assert_eq!(review["operationId"], "operation-a");
        assert!(review["progress"]["stage"]
            .as_str()
            .unwrap()
            .contains("could not be confirmed over SSH"));
        assert!(!review.to_string().contains("sensitive"));
        assert!(can_cancel(&review["state"]));
    }

    #[test]
    fn mismatched_or_invalid_launch_reply_retains_unknown() {
        for reply in [b"invalid JSON".to_vec(), serde_json::to_vec(&json!({"operationId":"operation-b","environmentId":"environment-a","state":"complete"})).unwrap()] {
            let mut review = unknown_review();
            apply_launch_result(&mut review, "environment-a", Ok(reply));
            assert_eq!(review["state"], "unknown");
            assert_eq!(review["operationId"], "operation-a");
            assert!(review["progress"]["stage"].as_str().unwrap().contains("could not be verified"));
        }
    }
}
fn path(setup: &Setup, environment: &str) -> Result<PathBuf, String> {
    environments::validate_id(environment)?;
    Ok(setup.directory.join(format!("update-{environment}.json")))
}
fn save(setup: &Setup, environment: &str, value: &Value) -> Result<(), String> {
    private_write(
        &path(setup, environment)?,
        &serde_json::to_vec(value).map_err(|_| "Invalid update receipt")?,
    )
}
fn load(setup: &Setup, environment: &str) -> Result<Value, String> {
    serde_json::from_slice(
        &fs::read(path(setup, environment)?).map_err(|_| "No update review for this server")?,
    )
    .map_err(|_| "Invalid update review".into())
}
#[tauri::command]
pub async fn environment_update_check(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
) -> Result<Value, String> {
    let _global_guard = automatic::acquire_global(&setup.directory)?;
    if automatic::reserved_environment(&setup, &environment_id)? {
        return load(&setup, &environment_id);
    }
    check_inner(app, setup, registry, environment_id).await
}
async fn check_inner(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
) -> Result<Value, String> {
    let _guard = acquire(&environment_id)?;
    // An unresolved operation is returned unchanged, even when either transport is offline.
    match fs::symlink_metadata(path(&setup, &environment_id)?) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => {
            let previous = load(&setup, &environment_id)?;
            if retain_previous_review(&previous) {
                return Ok(previous);
            }
        }
        _ => {
            return Err(
                "Existing update receipt is unreadable or unsafe; no review was replaced".into(),
            )
        }
    }
    let host = bundled_artifact(&app, ArtifactResource::Host)?
        .ok_or("Bundled host release unavailable")?;
    let pi = bundled_artifact(&app, ArtifactResource::Pi)?;
    let state = registry.get(&environment_id)?;
    let installed = state
        .agent_request(json!({"type":"runtime.inventory"}))
        .await?;
    let binding = registry
        .ssh_bindings()?
        .into_iter()
        .find(|(id, _)| id == &environment_id);
    let source = &installed["manifest"];
    let native =
        binding.is_some() && source["schema"] == 2 && source["compatibility"] == "native-v1";
    let mut runtime_pins_probe = Value::Null;
    let selected = if native {
        let setup = setup.inner().clone();
        let setup_id = binding
            .as_ref()
            .ok_or("Saved SSH route missing")?
            .1
            .setup_id
            .clone();
        let probe =
            tauri::async_runtime::spawn_blocking(move || probe_runtime_pins(&setup, &setup_id))
                .await
                .map_err(|_| "Runtime-pins check interrupted")??;
        runtime_pins_probe = probe.clone();
        select_artifact(&installed, &probe, &host, pi.as_ref())?
    } else {
        None
    };
    let (artifact_resource, artifact) = selected.unwrap_or((ArtifactResource::Host, &host));
    let (check_outcome, message) = release_check(
        &installed,
        artifact_resource,
        artifact,
        binding.is_some(),
        selected.is_some(),
    );
    let available = check_outcome == CheckOutcome::UpdateAvailable;
    let review = json!({"reviewId":Uuid::new_v4().to_string(),"operationId":Uuid::new_v4().to_string(),"environmentId":environment_id,
        "setupId":binding.map(|(_,b)|b.setup_id),"installed":installed,"runtimePinsProbe":runtime_pins_probe,"artifact":artifact,"artifactResource":artifact_resource.name(),
        "available":available,"checkOutcome":check_outcome,"state":"review","expiresAt":now()+300000,"message":message});
    save(&setup, &environment_id, &review)?;
    Ok(review)
}
#[tauri::command]
pub async fn environment_update_start(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
    review_id: String,
    approved: bool,
    password: bool,
) -> Result<Value, String> {
    let global_guard = automatic::acquire_global(&setup.directory)?;
    automatic::allow_manual_start(&setup, &environment_id)?;
    let _guard = acquire(&environment_id)?;
    let mut review = load(&setup, &environment_id)?;
    if !approved
        || review["reviewId"] != review_id
        || review["available"] != true
        || (review["state"] == "review" && review["expiresAt"].as_u64().unwrap_or(0) < now())
        || !["review", "authorizing"].contains(&review["state"].as_str().unwrap_or("unknown"))
    {
        return Err("Review expired or update already launched. Check status, never repeat an unknown launch.".into());
    }
    let archive = resource(&app, review_archive(&review)?)?;
    let state = registry.get(&environment_id)?;
    // Reserve the operation before the first server-side hold attempt. A lost reply
    // must not leave a replaceable review that forgets an already acquired hold.
    review["state"] = json!("authorizing");
    save(&setup, &environment_id, &review)?;
    let stage = state.agent_request(json!({"type":"maintenance.stage","operationId":review["operationId"],"expectedRelease":review["installed"]["releaseId"],"target":review["artifact"]["manifest"],"sha256":review["artifact"]["sha256"]})).await?;
    if stage["state"] != "staging" {
        return Err("Maintenance operation changed; reconcile its receipt".into());
    }
    let device = public_identity(&state)?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _global_guard = global_guard;
        let _guard = _guard;
        let id = review["setupId"].as_str().ok_or("Saved SSH route missing")?;
        let entry = setup.entry(id)?;
        let bytes = fs::read(archive).map_err(|_| "Bundled release unreadable")?;
        let digest = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>();
        if bytes.len()>16*1024*1024 || review["artifact"]["size"].as_u64()!=Some(bytes.len() as u64) || review["artifact"]["sha256"] != digest { return Err("Release checksum mismatch".into()); }
        let root = entry.inspection.as_ref().is_some_and(|v|v.uid==0);
        let mut input = zeroize::Zeroizing::new(Vec::new());
        if !root && password {
            let prompt=serde_json::to_string(&format!("Enter the sudo password for {}@{}. Authorize this reviewed Outpost update only; it is not saved.",entry.target.user,entry.target.host)).map_err(|_|"Invalid target")?;
            let script=format!("text returned of (display dialog {prompt} default answer \"\" with hidden answer buttons {{\"Cancel\",\"Authorize update\"}} default button \"Authorize update\" with title \"Outpost update\")");
            let mut secret=zeroize::Zeroizing::new(run("/usr/bin/osascript", &["-e".into(),script],b"",Duration::from_secs(180),&AtomicBool::new(false))?);
            while matches!(secret.last(),Some(b'\n'|b'\r')) { secret.pop(); }
            if secret.is_empty() || secret.len()>1024 || secret.contains(&b'\n') { return Err("Invalid authorization input".into()); }
            input.extend_from_slice(&secret); input.push(b'\n'); secret.fill(0);
        }
        let packet=json!({"operationId":review["operationId"],"environmentId":environment_id,"deviceId":device.0,"releaseId":review["artifact"]["id"],
            "expectedRelease":review["installed"]["releaseId"],"sha256":digest,"size":bytes.len(),"target":review["artifact"]["manifest"]});
        let bootstrap = bootstrap_source(COMMON, UPDATER, review["operationId"].as_str().ok_or("Invalid operation ID")?, &environment_id)?;
        input.extend_from_slice(STANDARD.encode(bootstrap).as_bytes()); input.push(b'\n');
        input.extend(serde_json::to_vec(&packet).map_err(|_|"Invalid packet")?); input.push(b'\n'); input.extend(bytes);
        let mut args=setup.ssh_args(&entry)?;
        args.extend(["--".into(),entry.target.host.clone(),manual_bootstrap_command(root, password)]);
        review["state"] = json!("unknown"); save(&setup, &environment_id, &review)?; // Durable immediately before launch.
        let result=run(setup.ssh_program(),&args,&input,Duration::from_secs(90),&AtomicBool::new(false)); input.fill(0);
        apply_launch_result(&mut review, &environment_id, result);
        save(&setup,&environment_id,&review)?; Ok(review)
    }).await.map_err(|_|"Update authorization interrupted; check status")?
}
#[tauri::command]
pub async fn environment_update_cancel(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
) -> Result<Value, String> {
    let _global_guard = automatic::acquire_global(&setup.directory)?;
    let _guard = acquire(&environment_id)?;
    let mut review = load(&setup, &environment_id)?;
    if !can_cancel(&review["state"]) {
        return Err("Only an update before activation can be cancelled here".into());
    }
    let state = registry.get(&environment_id)?;
    let owner = public_identity(&state)?.0;
    // Persist before the signed call: its reply may be lost even though cancellation succeeds.
    save_cancellation_intent(&setup, &environment_id, &mut review, &owner)?;
    let reply = state
        .agent_request(json!({"type":"maintenance.cancel","operationId":review["operationId"]}))
        .await;
    let reply = apply_cancel_reply(&mut review, reply, &owner)?;
    save(&setup, &environment_id, &review)?;
    refresh_host_status(
        setup.inner().clone(),
        _guard,
        review,
        environment_id,
        Some((reply, owner)),
    )
    .await
}
#[tauri::command]
pub async fn environment_update_status(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
) -> Result<Value, String> {
    let _global_guard = automatic::acquire_global(&setup.directory)?;
    status_inner(setup, registry, environment_id).await
}
async fn status_inner(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
) -> Result<Value, String> {
    let guard = acquire(&environment_id)?;
    let review = load(&setup, &environment_id)?;
    if !needs_host_status(&review) {
        return Ok(review);
    }
    // Keep coordinator evidence separate until the authoritative host probe has run.
    let mut coordinator = None;
    if let Ok(state) = registry.get(&environment_id) {
        if let Ok((owner, _)) = public_identity(&state) {
            if let Ok(reply) = state
                .agent_request(json!({"type":"maintenance.status"}))
                .await
            {
                coordinator = Some((reply, owner));
            }
        }
    }
    refresh_host_status(
        setup.inner().clone(),
        guard,
        review,
        environment_id,
        coordinator,
    )
    .await
}

async fn refresh_host_status(
    setup: Arc<Setup>,
    guard: UpdateGuard,
    mut review: Value,
    environment_id: String,
    coordinator: Option<(Value, String)>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let host = (|| -> Result<Value, String> {
            let operation = review["operationId"].as_str().ok_or("Invalid receipt")?;
            environments::validate_id(operation)?;
            let entry = setup.entry(review["setupId"].as_str().ok_or("Saved route missing")?)?;
            let source = format!("import json,pathlib,subprocess\np=pathlib.Path('/var/lib/outpost-setup/operations/{operation}/status.json')\nv=json.loads(p.read_text()) if p.is_file() else {{'state':'unknown'}}\nif v.get('state') in ('queued','staging','waiting_for_idle','activating','recovering') and subprocess.run(['/usr/bin/systemctl','is-active','--quiet','outpost-update-{operation}'],timeout=5).returncode: v['state']='needs_attention'\nprint(json.dumps(v))");
            let mut args = setup.ssh_args(&entry)?;
            args.extend(["--".into(), entry.target.host.clone(), python(&source)]);
            let bytes = run(
                setup.ssh_program(), &args, b"", Duration::from_secs(15), &AtomicBool::new(false),
            )?;
            serde_json::from_slice(&bytes).map_err(|_| "Invalid update receipt".into())
        })();
        review["hostStatusVerified"] = json!(host.as_ref().is_ok_and(|status|
            bound_host_receipt(&review, status, &environment_id)
                && status["releaseId"] == review["artifact"]["id"]));
        reconcile_status(
            &mut review, &environment_id, host,
            coordinator.as_ref().map(|(reply, owner)| (reply, owner.as_str())),
        )?;
        save(&setup, &environment_id, &review)?;
        Ok(review)
    })
    .await
    .map_err(|_| "Status check interrupted")?
}
