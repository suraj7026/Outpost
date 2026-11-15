//! Qualified bundled updates over pinned SSH. Reviews/receipts contain no credentials.
use super::install::{public_identity, python, resource};
use super::*;
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
const INSTALLER: &str = include_str!("../../../deploy/environment/host_install.py");
const UPDATER: &str = include_str!("../../../deploy/environment/host_update.py");
#[cfg(test)]
mod tests {
    use super::*;
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
    let _guard = acquire(&environment_id)?;
    let state = registry.get(&environment_id)?;
    let installed = state
        .agent_request(json!({"type":"runtime.inventory"}))
        .await?;
    let artifact: Value = serde_json::from_slice(
        &fs::read(resource(&app, "host-release.json")?).map_err(|_| "Release unavailable")?,
    )
    .map_err(|_| "Invalid bundled manifest")?;
    let binding = registry
        .ssh_bindings()?
        .into_iter()
        .find(|(id, _)| id == &environment_id);
    let source = &installed["manifest"];
    let target = &artifact["manifest"];
    let supported = binding.is_some()
        && source["schema"] == 2
        && target["schema"] == 2
        && source["compatibility"] == "native-v1"
        && target["compatibility"] == "native-v1";
    let available = supported
        && source["sequence"]
            .as_u64()
            .zip(target["sequence"].as_u64())
            .is_some_and(|(a, b)| b > a)
        && installed["releaseId"] != target["id"];
    if let Ok(previous) = load(&setup, &environment_id) {
        if !["review", "complete", "rolled_back", "failed", "cancelled"]
            .contains(&previous["state"].as_str().unwrap_or("unknown"))
        {
            return Ok(previous);
        }
    }
    let review = json!({"reviewId":Uuid::new_v4().to_string(),"operationId":Uuid::new_v4().to_string(),"environmentId":environment_id,
        "setupId":binding.map(|(_,b)|b.setup_id),"installed":installed,"artifact":artifact,"available":available,"state":"review","expiresAt":now()+300000,
        "message":if !supported {"This installation needs a qualified native maintenance release and a saved SSH route. Legacy/container installations are not reinstalled automatically."}
          else if available {"Review the bundled Pi and extension changes. Existing credentials, browser runtime and history are preserved."}
          else {"No newer qualified release is bundled with this app. Equal or older release sequences cannot update this server."}});
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
    let state = registry.get(&environment_id)?;
    // Reserve the operation before the first server-side hold attempt. A lost reply
    // must not leave a replaceable review that forgets an already acquired hold.
    review["state"] = json!("authorizing");
    save(&setup, &environment_id, &review)?;
    let stage = state.agent_request(json!({"type":"maintenance.stage","operationId":review["operationId"],"expectedRelease":review["installed"]["releaseId"],"target":review["artifact"]["manifest"],"sha256":review["artifact"]["sha256"]})).await?;
    if stage["state"] != "staging" {
        return Err("Maintenance operation changed; reconcile its receipt".into());
    }
    let archive = resource(&app, "host-release.tar.gz")?;
    let device = public_identity(&state)?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
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
        input.extend(serde_json::to_vec(&packet).map_err(|_|"Invalid packet")?); input.push(b'\n'); input.extend(bytes);
        let bootstrap=format!("import base64,types,sys\nm=types.ModuleType('host_install');sys.modules['host_install']=m\nexec(base64.b64decode('{}'),m.__dict__)\nexec(base64.b64decode('{}'))",STANDARD.encode(INSTALLER),STANDARD.encode(UPDATER));
        let authority=if root {""} else if password {"sudo -k -S -p '' -- "} else {"sudo -n -- "};
        let mut args=setup.ssh_args(&entry)?;
        args.extend(["--".into(),entry.target.host.clone(),format!("{authority}{} --bootstrap",python(&bootstrap))]);
        review["state"] = json!("unknown"); save(&setup, &environment_id, &review)?; // Durable immediately before launch.
        let result=run(setup.ssh_program(),&args,&input,Duration::from_secs(90),&AtomicBool::new(false)); input.fill(0);
        if let Ok(reply)=result {
            if let Ok(status)=serde_json::from_slice::<Value>(&reply) {
                if status["operationId"]==review["operationId"] && status["environmentId"]==environment_id { review["state"]=status["state"].clone(); review["progress"]=status; }
            }
        }
        save(&setup,&environment_id,&review)?; Ok(review)
    }).await.map_err(|_|"Update authorization interrupted; check status")?
}
#[tauri::command]
pub async fn environment_update_cancel(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
) -> Result<Value, String> {
    let _guard = acquire(&environment_id)?;
    let mut review = load(&setup, &environment_id)?;
    if !["authorizing", "queued", "staging", "waiting_for_idle"]
        .contains(&review["state"].as_str().unwrap_or("unknown"))
    {
        return Err("Only an update before activation can be cancelled here".into());
    }
    let state = registry.get(&environment_id)?;
    state
        .agent_request(json!({"type":"maintenance.cancel","operationId":review["operationId"]}))
        .await?;
    review["state"] = json!("cancelled");
    save(&setup, &environment_id, &review)?;
    Ok(review)
}
#[tauri::command]
pub async fn environment_update_status(
    setup: tauri::State<'_, Arc<Setup>>,
    environment_id: String,
) -> Result<Value, String> {
    let guard = acquire(&environment_id)?;
    let setup = setup.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let mut review=load(&setup,&environment_id)?;
        if ["review","authorizing","cancelled"].contains(&review["state"].as_str().unwrap_or("unknown")) { return Ok(review); }
        let operation=review["operationId"].as_str().ok_or("Invalid receipt")?; environments::validate_id(operation)?;
        let entry=setup.entry(review["setupId"].as_str().ok_or("Saved route missing")?)?;
        let source=format!("import json,pathlib,subprocess\np=pathlib.Path('/var/lib/outpost-setup/operations/{operation}/status.json')\nv=json.loads(p.read_text()) if p.is_file() else {{'state':'unknown'}}\nif v.get('state') in ('queued','staging','waiting_for_idle','activating','recovering') and subprocess.run(['/usr/bin/systemctl','is-active','--quiet','outpost-update-{operation}'],timeout=5).returncode: v['state']='needs_attention'\nprint(json.dumps(v))");
        let mut args=setup.ssh_args(&entry)?; args.extend(["--".into(),entry.target.host.clone(),python(&source)]);
        let bytes=run(setup.ssh_program(),&args,b"",Duration::from_secs(15),&AtomicBool::new(false))?;
        let status:Value=serde_json::from_slice(&bytes).map_err(|_|"Invalid update receipt")?;
        if status["operationId"]==review["operationId"] && status["environmentId"]==environment_id {
            review["state"]=status["state"].clone(); review["progress"]=status; save(&setup,&environment_id,&review)?;
        }
        Ok(review)
    }).await.map_err(|_|"Status check interrupted")?
}
