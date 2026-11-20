//! Opt-in native updates. The durable reservation, not connectivity, owns the queue.
use super::*;
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use std::collections::BTreeSet;

const HELPER: &str = include_str!("../../../deploy/environment/auto_update.py");
const JOURNAL: &str = "automatic-updates.json";
const LAUNCH: &str = "sudo -n -- /usr/local/libexec/outpost-update";
pub(super) const BOOTSTRAP_LOADER: &str = "import os,base64\nb=bytearray()\nwhile True:\n c=os.read(0,1)\n if c==b'\\n': break\n if not c or len(b)>1048576: raise ValueError('Invalid bootstrap')\n b.extend(c)\nexec(compile(base64.b64decode(b,validate=True),'outpost-bootstrap','exec'))";
pub(super) fn isolated_python(source: &str) -> String {
    python(source).replacen("/usr/bin/python3 -c", "/usr/bin/python3 -I -c", 1)
}
static GLOBAL: AtomicBool = AtomicBool::new(false);
pub(super) struct GlobalGuard {
    lock: Option<fs::File>,
}
impl Drop for GlobalGuard {
    fn drop(&mut self) {
        // Closing the descriptor releases the cross-process flock before another
        // in-process operation is admitted. No mutex is held across an await.
        self.lock.take();
        GLOBAL.store(false, Ordering::Release);
    }
}
pub(super) fn acquire_global(directory: &std::path::Path) -> Result<GlobalGuard, String> {
    GLOBAL
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "An update or enrollment is already in progress")?;
    let mut guard = GlobalGuard { lock: None };
    #[cfg(unix)]
    {
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        let file = fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join("automatic-updates.lock"))
            .map_err(|_| "Global update lock unavailable")?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("Another app process owns the update queue".into());
        }
        guard.lock = Some(file);
        Ok(guard)
    }
    #[cfg(not(unix))]
    {
        let _ = directory;
        Err("Native update locking is unavailable on this platform".into())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Enrolling,
    Ready,
    Checked,
    Authorizing,
    Updating,
    Unknown,
    Verifying,
    Complete,
    Failed,
    RolledBack,
    Blocked,
    NeedsAttention,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Server {
    environment_id: String,
    state: Phase,
    message: String,
    release_id: Option<String>,
    policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_policy: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enrollment_attempt_id: Option<String>,
    review_id: Option<String>,
    operation_id: Option<String>,
}
impl Server {
    fn new(id: String) -> Self {
        Self {
            environment_id: id,
            state: Phase::Ready,
            message: "Waiting for a read-only update check".into(),
            release_id: None,
            policy: None,
            previous_policy: None,
            enrollment_attempt_id: None,
            review_id: None,
            operation_id: None,
        }
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    schema: u32,
    enabled: bool,
    targets: Vec<String>,
    active_environment_id: Option<String>,
    servers: BTreeMap<String, Server>,
    cursor: usize,
}
impl Default for Journal {
    fn default() -> Self {
        Self {
            schema: 1,
            enabled: false,
            targets: vec![],
            active_environment_id: None,
            servers: BTreeMap::new(),
            cursor: 0,
        }
    }
}
impl Journal {
    fn read(directory: &std::path::Path) -> Result<Self, String> {
        let path = directory.join(JOURNAL);
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Ok(meta)
                if meta.is_file()
                    && !meta.file_type().is_symlink()
                    && meta.len() <= 1024 * 1024 => {}
            _ => return Err("Automatic update journal unavailable; updates are blocked".into()),
        }
        let journal: Self = serde_json::from_slice(
            &fs::read(path).map_err(|_| "Automatic update journal unreadable")?,
        )
        .map_err(|_| "Automatic update journal corrupt; updates are blocked")?;
        journal.validate()?;
        Ok(journal)
    }
    fn validate(&self) -> Result<(), String> {
        if self.schema != 1
            || self.targets.len() > 128
            || self.servers.len() > 128
            || self.targets.iter().collect::<BTreeSet<_>>().len() != self.targets.len()
            || self.targets.iter().any(|id| !self.servers.contains_key(id))
            || self
                .active_environment_id
                .as_ref()
                .is_some_and(|id| !self.servers.contains_key(id))
        {
            return Err("Invalid automatic update journal; updates are blocked".into());
        }
        for (id, server) in &self.servers {
            environments::validate_id(id)?;
            if id != &server.environment_id {
                return Err("Journal identity mismatch".into());
            }
            if matches!(
                server.state,
                Phase::Enrolling
                    | Phase::Authorizing
                    | Phase::Updating
                    | Phase::Unknown
                    | Phase::Verifying
            ) && self.active_environment_id.as_ref() != Some(id)
            {
                return Err("Unowned automatic operation; updates are blocked".into());
            }
            if let Some(operation) = &server.operation_id {
                environments::validate_id(operation)?;
            }
            if let Some(attempt) = &server.enrollment_attempt_id {
                environments::validate_id(attempt)?;
            }
        }
        Ok(())
    }
    fn write(&self, directory: &std::path::Path) -> Result<(), String> {
        self.validate()?;
        private_write(
            &directory.join(JOURNAL),
            &serde_json::to_vec(self).map_err(|_| "Invalid automatic update journal")?,
        )
    }
    fn status(&self) -> Value {
        let servers: Vec<_> = self
            .servers
            .values()
            .map(|s| {
                let state = if self.active_environment_id.as_deref() != Some(&s.environment_id)
                    && (!self.enabled
                        || !self.targets.contains(&s.environment_id)
                        || s.policy.is_none())
                {
                    json!("not_enabled")
                } else if s.state == Phase::Ready {
                    json!("idle")
                } else {
                    json!(s.state)
                };
                let mut value =
                    json!({"environmentId":s.environment_id,"state":state,"message":s.message});
                if let Some(release) = &s.release_id {
                    value["releaseId"] = json!(release);
                }
                value
            })
            .collect();
        json!({"enabled":self.enabled,"targets":self.targets,"activeEnvironmentId":self.active_environment_id,"servers":servers})
    }
    fn hold(&mut self, id: &str, phase: Phase, message: &str) {
        self.active_environment_id = Some(id.into());
        if let Some(server) = self.servers.get_mut(id) {
            server.state = phase;
            server.message = message.into();
        }
    }
}

pub(super) fn reserved_environment(setup: &Setup, environment: &str) -> Result<bool, String> {
    Ok(Journal::read(&setup.directory)?
        .active_environment_id
        .as_deref()
        == Some(environment))
}
pub(super) fn allow_manual_start(setup: &Setup, environment: &str) -> Result<(), String> {
    if Journal::read(&setup.directory)?
        .active_environment_id
        .is_some()
    {
        return Err("Automatic update queue is reserved. Inspect its existing operation before a manual launch".into());
    }
    unresolved_manual(setup, Some(environment))
}
fn unresolved_manual(setup: &Setup, except: Option<&str>) -> Result<(), String> {
    for item in fs::read_dir(&setup.directory).map_err(|_| "Update receipts unavailable")? {
        let item = item.map_err(|_| "Update receipt unavailable")?;
        let name = item.file_name();
        let Some(id) = name
            .to_str()
            .and_then(|n| n.strip_prefix("update-"))
            .and_then(|n| n.strip_suffix(".json"))
        else {
            continue;
        };
        if Some(id) == except {
            continue;
        }
        let review = load(setup, id)?;
        if retain_previous_review(&review) {
            return Err(
                "An existing update receipt is unresolved; the global queue is held".into(),
            );
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Authorization {
    payload: String,
    signature: String,
    publisher_public_key: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignedRelease {
    schema: u32,
    manifest: Value,
    sha256: String,
    size: u64,
    runtime_pins_sha256: String,
    required_tools: Vec<String>,
}
fn decode_fixed<const N: usize>(text: &str) -> Result<[u8; N], String> {
    STANDARD
        .decode(text)
        .map_err(|_| "Invalid signature encoding")?
        .try_into()
        .map_err(|_| "Invalid signature length".into())
}
pub(super) fn verify_authorization(
    artifact: &Value,
    pinned: Option<&str>,
) -> Result<Value, String> {
    let authorization: Authorization = serde_json::from_value(artifact["authorization"].clone())
        .map_err(|_| "A complete publisher-signed release is required")?;
    if pinned.is_some_and(|key| key != authorization.publisher_public_key) {
        return Err("Publisher identity changed; updates are blocked".into());
    }
    let payload = STANDARD
        .decode(&authorization.payload)
        .map_err(|_| "Invalid publisher payload")?;
    if payload.len() > 32768 {
        return Err("Publisher payload too large".into());
    }
    let key = VerifyingKey::from_bytes(&decode_fixed::<32>(&authorization.publisher_public_key)?)
        .map_err(|_| "Invalid publisher key")?;
    key.verify_strict(
        &payload,
        &Signature::from_bytes(&decode_fixed::<64>(&authorization.signature)?),
    )
    .map_err(|_| "Publisher signature rejected")?;
    let signed: SignedRelease =
        serde_json::from_slice(&payload).map_err(|_| "Invalid signed release fields")?;
    if signed.schema != 1
        || signed.manifest != artifact["manifest"]
        || artifact["id"] != signed.manifest["id"]
        || artifact["sha256"] != signed.sha256
        || artifact["size"] != signed.size
        || artifact["runtimePinsSha256"] != signed.runtime_pins_sha256
        || !is_sha256(&json!(signed.sha256))
        || !is_sha256(&json!(signed.runtime_pins_sha256))
        || signed.size == 0
        || signed.size > 16 * 1024 * 1024
        || signed.required_tools.len() > 128
        || signed.required_tools.iter().collect::<BTreeSet<_>>().len()
            != signed.required_tools.len()
        || signed.required_tools.iter().any(|tool| {
            tool.is_empty()
                || tool.len() > 128
                || !tool.as_bytes()[0].is_ascii_alphabetic()
                || !tool
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        })
        || [
            "automation.list",
            "automation.save",
            "automation.set_paused",
        ]
        .iter()
        .any(|tool| !signed.required_tools.iter().any(|name| name == tool))
    {
        return Err("Signed complete-release metadata does not match the bundled artifact".into());
    }
    validate_manifest(&signed.manifest)?;
    serde_json::from_slice(&payload).map_err(|_| "Invalid authorization payload".into())
}
pub(super) fn validate_manifest(m: &Value) -> Result<(), String> {
    let fields = [
        "schema",
        "id",
        "protocolVersion",
        "layoutVersion",
        "compatibility",
        "sequence",
        "piVersion",
        "extensions",
        "rollback",
    ];
    if !m
        .as_object()
        .is_some_and(|o| o.len() == fields.len() && fields.iter().all(|k| o.contains_key(*k)))
        || m["schema"] != 2
        || m["protocolVersion"] != 2
        || m["layoutVersion"] != 1
        || m["compatibility"] != "native-v1"
        || m["rollback"] != true
        || !m["id"].as_str().is_some_and(canonical_host_release)
        || !m["sequence"]
            .as_u64()
            .is_some_and(|n| n > 0 && n <= 9_007_199_254_740_991)
        || !m["piVersion"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 64)
        || !m["extensions"].as_array().is_some_and(|a| {
            a.len() <= 64
                && a.iter().all(|e| {
                    e.as_object().is_some_and(|o| o.len() == 2)
                        && e["name"]
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
                        && e["version"]
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && s.len() <= 64)
                })
        })
    {
        return Err("Unsupported signed release manifest".into());
    }
    Ok(())
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn policy(environment: &str, device: &str, publisher: &str, user: &str) -> Value {
    json!({"environmentId":environment,"deviceId":device,"publisherPublicKey":publisher,"sshUser":user})
}
fn public_policy(policy: &Value) -> Value {
    let mut public = policy.clone();
    public["schema"] = json!(1);
    public["sourcesSha256"] = json!({"auto_update.py":sha(HELPER.as_bytes()),"common.py":sha(COMMON.as_bytes()),"host_update.py":sha(UPDATER.as_bytes())});
    public
}
const RENEW_HELPER: &str = "The enrolled update helper differs from this app's security-reviewed helper. No maintenance request was submitted. Disable automatic updates, then enable them with renewed protected authorization to update the helper; no unattended helper migration is permitted.";
fn policy_identity(public: &Value) -> Result<Value, String> {
    let fields = [
        "schema",
        "environmentId",
        "deviceId",
        "publisherPublicKey",
        "sshUser",
        "sourcesSha256",
    ];
    if public["schema"] != 1
        || !public.as_object().is_some_and(|value| {
            value.len() == fields.len() && fields.iter().all(|field| value.contains_key(*field))
        })
    {
        return Err("Invalid public enrollment policy".into());
    }
    let environment = public["environmentId"]
        .as_str()
        .ok_or("Missing policy environment")?;
    let device = public["deviceId"].as_str().ok_or("Missing policy device")?;
    environments::validate_id(environment)?;
    environments::validate_id(device)?;
    let publisher = public["publisherPublicKey"]
        .as_str()
        .ok_or("Missing policy publisher")?;
    decode_fixed::<32>(publisher)?;
    let user = public["sshUser"]
        .as_str()
        .ok_or("Missing policy SSH user")?;
    if user.is_empty()
        || user.len() > 32
        || !user.bytes().enumerate().all(|(i, c)| {
            c == b'_' || c.is_ascii_lowercase() || (i > 0 && (c.is_ascii_digit() || c == b'-'))
        })
    {
        return Err("Invalid policy SSH user".into());
    }
    let sources = public["sourcesSha256"]
        .as_object()
        .ok_or("Missing helper source pins")?;
    let valid_sources = [
        ["auto_update.py", "common.py", "host_update.py"],
        ["auto_update.py", "host_install.py", "host_update.py"],
    ]
    .iter()
    .any(|names| {
        sources.len() == names.len()
            && names
                .iter()
                .all(|name| sources.get(*name).is_some_and(is_sha256))
    });
    if !valid_sources {
        return Err("Invalid helper source pins".into());
    }
    Ok(policy(environment, device, publisher, user))
}
fn verify_current_helper(enrolled: &Value, observed: &Value) -> Result<(), String> {
    let identity = policy_identity(enrolled)?;
    if policy_identity(observed)? != identity {
        return Err(
            "Enrolled environment/device/publisher/SSH identity changed; updates are blocked"
                .into(),
        );
    }
    let current = public_policy(&identity);
    if observed != &current || enrolled != &current {
        return Err(RENEW_HELPER.into());
    }
    Ok(())
}
#[derive(Debug, PartialEq)]
enum EnrollmentAction {
    Existing,
    Fresh,
    Renew(Value),
}
fn enrollment_action(
    saved: Option<&Value>,
    observed: &Value,
    desired: &Value,
) -> Result<EnrollmentAction, String> {
    let identity = policy_identity(desired)?;
    if let Some(saved) = saved {
        if policy_identity(saved)? != identity {
            return Err(
                "Enrollment identity changed; authorization cannot migrate identities".into(),
            );
        }
    }
    if observed.is_null() {
        return if saved.is_none() {
            Ok(EnrollmentAction::Fresh)
        } else {
            Err("Previous enrollment disappeared; reauthorization is blocked".into())
        };
    }
    if policy_identity(observed)? != identity {
        return Err("Existing enrollment identity differs; no grant was changed".into());
    }
    if observed == desired {
        return Ok(EnrollmentAction::Existing);
    }
    if saved.is_some_and(|saved| saved != observed) {
        return Err("Public helper policy changed from the saved enrollment; inspect before renewed authorization".into());
    }
    Ok(EnrollmentAction::Renew(observed.clone()))
}
const POLICY_PROBE: &str = r#"import json,pathlib,hashlib,stat,subprocess
p=pathlib.Path('/etc/outpost-native/auto-update.json')
def secure(p,directory=False):
 for item in (*reversed(p.parents),p):
  s=item.lstat()
  if s.st_uid!=0 or s.st_mode & 0o022 or stat.S_ISLNK(s.st_mode): raise ValueError('Unsafe enrollment path')
  if item!=p or directory:
   if not stat.S_ISDIR(s.st_mode): raise ValueError('Unsafe enrollment directory')
  elif not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError('Unsafe enrollment file')
def read(p,limit):
 secure(p)
 with p.open('rb') as f: value=f.read(limit+1)
 if len(value)>limit: raise ValueError('Enrollment file too large')
 return value
if not p.exists() and not p.is_symlink():
 if any(pathlib.Path(x).exists() or pathlib.Path(x).is_symlink() for x in ['/usr/local/lib/outpost-updater','/usr/local/libexec/outpost-update','/etc/sudoers.d/outpost-update']): raise ValueError('Partial enrollment')
 print('null')
else:
 v=json.loads(read(p,65536)); hashes=v['sourcesSha256']
 candidates=(('auto_update.py','common.py','host_update.py'),('auto_update.py','host_install.py','host_update.py'))
 names=next((c for c in candidates if isinstance(hashes,dict) and set(hashes)==set(c)),None)
 if names is None or any(not isinstance(hashes[n],str) or len(hashes[n])!=64 or any(c not in '0123456789abcdef' for c in hashes[n]) for n in names): raise ValueError('Invalid source pins')
 root=pathlib.Path('/usr/local/lib/outpost-updater'); secure(root,True)
 versions=root/'versions'
 if versions.exists() or versions.is_symlink(): secure(versions,True)
 version=hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest()
 candidate=versions/version
 if candidate.exists() or candidate.is_symlink(): root=candidate; secure(root,True)
 for name in names:
  if hashlib.sha256(read(root/name,1048576)).hexdigest()!=hashes[name]: raise ValueError('Helper changed')
 if read(pathlib.Path('/usr/local/libexec/outpost-update'),1048576) not in trusted_launchers: raise ValueError('Launcher changed')
 r=subprocess.run(['/usr/bin/sudo','-n','-l','--','/usr/local/libexec/outpost-update'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=5)
 if r.returncode: raise ValueError('Enrollment grant unavailable')
 print(json.dumps(v))
"#;
fn policy_probe_source() -> Result<String, String> {
    // Read only the bundled Python byte literals. literal_eval never imports or
    // executes either the bundled helper or the remote enrolled helper.
    let mut literals = Vec::new();
    for name in ["LEGACY_LAUNCHER", "LAUNCHER", "LEGACY_VERSIONED_LAUNCHER"] {
        let prefix = format!("\n{name} = b'''");
        let body = HELPER
            .split_once(&prefix)
            .and_then(|(_, tail)| tail.split_once("'''"))
            .map(|(literal, _)| literal)
            .ok_or("Bundled helper launcher contract unavailable")?;
        literals.push(STANDARD.encode(format!("b'''{body}'''")));
    }
    Ok(format!("import ast,base64\ntrusted_launchers=tuple(ast.literal_eval(base64.b64decode(s).decode()) for s in {})\n{}", serde_json::to_string(&literals).map_err(|_| "Invalid launcher literals")?, POLICY_PROBE))
}
fn inspect_policy(setup: &Setup, entry: &Entry) -> Result<Value, String> {
    ssh_json(setup, entry, &policy_probe_source()?, 15)
}
fn ssh_json(setup: &Setup, entry: &Entry, source: &str, timeout: u64) -> Result<Value, String> {
    let mut args = setup.ssh_args(entry)?;
    args.extend([
        "--".into(),
        entry.target.host.clone(),
        isolated_python(source),
    ]);
    let bytes = run(
        setup.ssh_program(),
        &args,
        b"",
        Duration::from_secs(timeout),
        &AtomicBool::new(false),
    )
    .map_err(|_| "Pinned SSH verification unavailable; no authorization was assumed")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid pinned SSH verification".into())
}
const RENEWAL_RECEIPT: &str = "/etc/outpost-native/auto-update-native-renewal.json";
fn enrollment_inspection_source() -> Result<String, String> {
    Ok(format!(
        r#"import base64,contextlib,io,json,pathlib
output=io.StringIO()
with contextlib.redirect_stdout(output):
 exec(base64.b64decode('{probe}'))
policy=json.loads(output.getvalue())
receipt_path=pathlib.Path('{receipt}')
receipt=json.loads(read(receipt_path,65536)) if receipt_path.exists() or receipt_path.is_symlink() else None
print(json.dumps({{'policy':policy,'receipt':receipt}}))
"#,
        probe = STANDARD.encode(policy_probe_source()?),
        receipt = RENEWAL_RECEIPT
    ))
}
fn terminal_previous_renewal(server: &Server, observed: &Value, receipt: &Value) -> bool {
    let Some(attempt) = server.enrollment_attempt_id.as_deref() else {
        return false;
    };
    let (Some(previous), Some(desired)) = (&server.previous_policy, &server.policy) else {
        return false;
    };
    let fields = [
        "schema",
        "attemptId",
        "environmentId",
        "previousPolicy",
        "desiredPolicy",
        "state",
    ];
    environments::validate_id(attempt).is_ok()
        && receipt.as_object().is_some_and(|object| {
            object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
        })
        && receipt["schema"] == 1
        && receipt["state"] == "previous_retained"
        && receipt["attemptId"] == attempt
        && receipt["environmentId"] == server.environment_id
        && receipt["previousPolicy"] == *previous
        && receipt["desiredPolicy"] == *desired
        && observed == previous
        && previous["environmentId"] == server.environment_id
        && policy_identity(previous)
            .ok()
            .zip(policy_identity(desired).ok())
            .is_some_and(|(a, b)| a == b)
}
fn renewal_action(policy: &Value, previous: &Value, attempt: &str) -> Result<String, String> {
    environments::validate_id(attempt)?;
    if policy_identity(previous)? != *policy {
        return Err("Renewal identity mismatch".into());
    }
    let receipt = json!({"schema":1,"attemptId":attempt,"environmentId":policy["environmentId"],"previousPolicy":previous,"desiredPolicy":public_policy(policy),"state":"running"});
    Ok(format!(
        r#"receipt=json.loads(base64.b64decode('{receipt}'))
previous=receipt['previousPolicy']
h=sys.modules['auto_update']
h.require(h.os.geteuid()==0)
h.validate_public_policy(previous,allow_legacy=True)
h.validate_public_policy(receipt['desiredPolicy'])
h.secure_path(h.CONFIG,directory=True)
receipt_path=h.CONFIG/'auto-update-native-renewal.json'
if receipt_path.exists() or receipt_path.is_symlink(): h.secure_path(receipt_path)
h.atomic_json(receipt_path,receipt,0o644)
try:
 value=h.reauthorize(p,previous,raw['auto_update'],raw['host_update'],raw['common'])
except Exception:
 receipt['state']='unknown'
 try:
  actual=h.read_public(h.CONFIG/'auto-update.json')
  if actual==previous:
   h.verify_sources(h.active_library(actual,allow_legacy=True),actual,allow_legacy=True)
   receipt['state']='previous_retained'
 except Exception:
  pass
 h.atomic_json(receipt_path,receipt,0o644)
 raise
else:
 receipt['state']='complete'
 h.atomic_json(receipt_path,receipt,0o644)
 print(json.dumps(value))
"#,
        receipt =
            STANDARD.encode(serde_json::to_vec(&receipt).map_err(|_| "Invalid renewal receipt")?)
    ))
}
fn enrollment_source(
    policy: &Value,
    previous: Option<&Value>,
    attempt: Option<&str>,
) -> Result<String, String> {
    if previous.is_some() != attempt.is_some() {
        return Err("Renewal requires its own durable attempt identity".into());
    }
    if let Some(previous) = previous {
        if policy_identity(previous)? != *policy {
            return Err("Renewed authorization cannot change enrollment identity".into());
        }
    }
    let policy_bytes = serde_json::to_vec(policy).map_err(|_| "Invalid enrollment policy")?;
    let action = if let Some(previous) = previous {
        renewal_action(policy, previous, attempt.ok_or("Missing renewal attempt")?)?
    } else {
        "print(json.dumps(sys.modules['auto_update'].enroll(p,raw['auto_update'],raw['host_update'],raw['common'])))".into()
    };
    Ok(format!(
        r#"import base64,json,types,sys,hashlib
sources={{'common':'{common}','host_update':'{updater}','auto_update':'{helper}'}}
hashes={{'common':'{common_hash}','host_update':'{updater_hash}','auto_update':'{helper_hash}'}}
raw={{}}
for name,encoded in sources.items():
 data=base64.b64decode(encoded,validate=True)
 if hashlib.sha256(data).hexdigest()!=hashes[name]: raise ValueError('Bundled helper mismatch')
 raw[name]=data
 m=types.ModuleType(name);sys.modules[name]=m;exec(compile(data,name+'.py','exec'),m.__dict__)
p=json.loads(base64.b64decode('{policy}'))
{action}
"#,
        common = STANDARD.encode(COMMON),
        updater = STANDARD.encode(UPDATER),
        helper = STANDARD.encode(HELPER),
        common_hash = sha(COMMON.as_bytes()),
        updater_hash = sha(UPDATER.as_bytes()),
        helper_hash = sha(HELPER.as_bytes()),
        policy = STANDARD.encode(policy_bytes)
    ))
}
fn enrollment_input(
    entry: &Entry,
    password: bool,
    renewal: bool,
) -> Result<zeroize::Zeroizing<Vec<u8>>, String> {
    let scope = if renewal {
        "Renew authorization to replace the enrolled helper code with this app's security-reviewed helper. The exact reviewed old policy must still match; environment, device, publisher, SSH user and narrow sudo scope cannot change."
    } else {
        "Authorize the no-argument, publisher- and device-signed update helper only."
    };
    let prompt = serde_json::to_string(&format!("Automatic Outpost updates for {}@{}. {scope} This does not grant a general root shell. Disabling in Outpost does not revoke the server grant. {}", entry.target.user, entry.target.host, if password { "Enter the sudo password; it is never saved." } else { "Use existing sudo authorization?" })).map_err(|_| "Invalid enrollment prompt")?;
    let field = if password {
        " default answer \"\" with hidden answer"
    } else {
        ""
    };
    let result = if password {
        "text returned of reply"
    } else {
        "\"approved\""
    };
    let script = format!("set reply to display dialog {prompt}{field} buttons {{\"Cancel\",\"Enable automatic updates\"}} default button \"Cancel\" cancel button \"Cancel\" with title \"Outpost automatic updates\" giving up after 170\nif gave up of reply then error number -128\nreturn {result}");
    let mut secret = zeroize::Zeroizing::new(
        run(
            "/usr/bin/osascript",
            &["-e".into(), script],
            b"",
            Duration::from_secs(180),
            &AtomicBool::new(false),
        )
        .map_err(|_| "Native enrollment authorization was not completed")?,
    );
    while matches!(secret.last(), Some(b'\n' | b'\r')) {
        secret.pop();
    }
    if secret.is_empty()
        || secret.len() > 1024
        || secret.contains(&b'\n')
        || secret.contains(&b'\r')
        || secret.contains(&0)
    {
        return Err("Invalid native authorization response".into());
    }
    if password {
        secret.push(b'\n');
    } else {
        secret.clear();
    }
    Ok(secret)
}
fn enroll(
    setup: &Setup,
    entry: &Entry,
    policy: &Value,
    previous: Option<&Value>,
    attempt: Option<&str>,
    password: bool,
    mut input: zeroize::Zeroizing<Vec<u8>>,
) -> Result<(), String> {
    let authority = if password {
        "sudo -k -S -p '' -- "
    } else {
        "sudo -n -- "
    };
    // Large modules travel on stdin, never in an SSH command argument. Read exactly one
    // source line without buffering into sudo's password reader or an executable file.
    let source = STANDARD.encode(enrollment_source(policy, previous, attempt)?);

    input.extend_from_slice(source.as_bytes());
    input.push(b'\n');
    let mut args = setup.ssh_args(entry)?;
    args.extend([
        "--".into(),
        entry.target.host.clone(),
        format!("{authority}{}", isolated_python(BOOTSTRAP_LOADER)),
    ]);
    let output = run(
        setup.ssh_program(),
        &args,
        &input,
        Duration::from_secs(90),
        &AtomicBool::new(false),
    );
    input.fill(0);
    let actual: Value = serde_json::from_slice(&output.map_err(|_| {
        "Enrollment outcome unknown; inspect public policy without repeating authorization"
    })?)
    .map_err(|_| "Enrollment reply unknown")?;
    if actual != public_policy(policy) {
        return Err("Enrollment policy identity mismatch".into());
    }
    if inspect_policy(setup, entry)? != actual {
        return Err("Enrollment verification uncertain".into());
    }
    Ok(())
}
fn sign_request(
    request: &Value,
    authorization: &Value,
    key: &SigningKey,
) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(request).map_err(|_| "Invalid update request")?;
    let header = json!({"requestBase64":STANDARD.encode(&bytes),"authorization":authorization,"deviceSignature":STANDARD.encode(key.sign(&bytes).to_bytes())});
    let mut frame = serde_json::to_vec(&header).map_err(|_| "Invalid signed update header")?;
    if frame.len() >= 65536 {
        return Err("Update header too large".into());
    }
    frame.push(b'\n');
    Ok(frame)
}

#[tauri::command]
pub fn automatic_updates_status(setup: tauri::State<'_, Arc<Setup>>) -> Result<Value, String> {
    setup.ready()?;
    Ok(Journal::read(&setup.directory)?.status())
}
#[tauri::command]
pub fn automatic_updates_disable(setup: tauri::State<'_, Arc<Setup>>) -> Result<Value, String> {
    let _guard = acquire_global(&setup.directory)?;
    setup.ready()?;
    let mut journal = Journal::read(&setup.directory)?;
    journal.enabled = false;
    for server in journal.servers.values_mut() {
        server.message = "Local automatic launching disabled. The server sudo grant is NOT revoked; existing operations are still inspected.".into();
    }
    journal.write(&setup.directory)?;
    Ok(journal.status())
}
fn enrollment_artifact<'a>(
    installed: &Value,
    probe: &Value,
    host: &'a Value,
    pi: Option<&'a Value>,
) -> Result<&'a Value, String> {
    let (_, artifact) = select_artifact(installed, probe, host, pi)?
        .ok_or("No signed bundled release matches this server's runtime family")?;
    if !signed_runtime_family_matches(installed, probe, artifact)? {
        return Err("Enrollment requires a signed compatible runtime family".into());
    }
    // Enrollment grants the pinned publisher/device, not an update attempt. Equal
    // or older bundled releases may enroll, but cannot pass update admission.
    Ok(artifact)
}
#[tauri::command]
pub async fn automatic_updates_enable(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_ids: Vec<String>,
    approved: bool,
    password: bool,
) -> Result<Value, String> {
    let _guard = acquire_global(&setup.directory)?;
    setup.ready()?;
    if !approved {
        return Err("Explicit automatic update approval is required".into());
    }
    let mut journal = Journal::read(&setup.directory)?;
    if journal.active_environment_id.is_some() {
        return Err("Inspect the reserved operation before changing automatic targets".into());
    }
    unresolved_manual(&setup, None)?;
    let bindings = registry.ssh_bindings()?;
    let ids = if environment_ids.is_empty() {
        bindings
            .iter()
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>()
    } else {
        environment_ids
    };
    if ids.is_empty() || ids.len() > 128 || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err("Choose distinct saved SSH environments".into());
    }
    let host = bundled_artifact(&app, ArtifactResource::Host)?
        .ok_or("Signed bundled release unavailable")?;
    let pi = bundled_artifact(&app, ArtifactResource::Pi)?;
    for id in &ids {
        environments::validate_id(id)?;
        if !bindings.iter().any(|(saved, _)| saved == id) {
            return Err("Automatic updates require saved pinned SSH environments".into());
        }
    }
    journal.targets = ids.clone();
    // Do not launch on the first host if a later target's enrollment fails.
    journal.enabled = false;
    for id in &ids {
        journal
            .servers
            .entry(id.clone())
            .or_insert_with(|| Server::new(id.clone()));
    }
    journal.write(&setup.directory)?;
    for id in ids {
        let binding = &bindings
            .iter()
            .find(|(saved, _)| saved == &id)
            .ok_or("Saved route missing")?
            .1;
        let state = registry.get(&id)?;
        // Authentication succeeds with the existing device, never a replacement enrollment.
        let installed = state
            .agent_request(json!({"type":"runtime.inventory"}))
            .await?;
        let device = public_identity(&state)?;
        let entry = setup.entry(&binding.setup_id)?;
        let probe = {
            let setup = setup.inner().clone();
            let setup_id = binding.setup_id.clone();
            tauri::async_runtime::spawn_blocking(move || probe_runtime_pins(&setup, &setup_id))
                .await
                .map_err(|_| "Enrollment runtime-family inspection interrupted")??
        };
        let artifact = enrollment_artifact(&installed, &probe, &host, pi.as_ref())?;
        let publisher = artifact["authorization"]["publisherPublicKey"]
            .as_str()
            .ok_or("Publisher pin missing")?;
        let expected = policy(&id, &device.0, publisher, &entry.target.user);

        let observed = {
            let setup = setup.inner().clone();
            let entry = entry.clone();
            tauri::async_runtime::spawn_blocking(move || inspect_policy(&setup, &entry))
                .await
                .map_err(|_| "Policy inspection interrupted")??
        };
        let action = enrollment_action(
            journal.servers[&id].policy.as_ref(),
            &observed,
            &public_policy(&expected),
        )?;
        let previous = match action {
            EnrollmentAction::Existing => {
                let server = journal.servers.get_mut(&id).ok_or("Missing target")?;
                server.policy = Some(observed);
                server.previous_policy = None;
                server.enrollment_attempt_id = None;
                server.state = Phase::Ready;
                server.message =
                    "Existing current helper verified; no renewed authorization needed".into();
                journal.write(&setup.directory)?;
                continue;
            }
            EnrollmentAction::Fresh => None,
            EnrollmentAction::Renew(previous) => Some(previous),
        };
        let renewal = previous.is_some();
        let input = {
            let entry = entry.clone();
            tauri::async_runtime::spawn_blocking(move || {
                enrollment_input(&entry, password, renewal)
            })
            .await
            .map_err(|_| "Native enrollment prompt interrupted")??
        };
        let attempt = renewal.then(|| Uuid::new_v4().to_string());
        let server = journal.servers.get_mut(&id).ok_or("Missing target")?;
        server.policy = Some(public_policy(&expected));
        server.previous_policy = previous.clone();
        server.enrollment_attempt_id = attempt.clone();
        journal.hold(&id,Phase::Enrolling,"Enrollment reserved. If interrupted, inspect public policy only; never repeat root bootstrap automatically.");
        journal.write(&setup.directory)?;
        let result = {
            let setup = setup.inner().clone();
            tauri::async_runtime::spawn_blocking(move || {
                enroll(
                    &setup,
                    &entry,
                    &expected,
                    previous.as_ref(),
                    attempt.as_deref(),
                    password,
                    input,
                )
            })
            .await
            .map_err(|_| "Enrollment interrupted")?
        };
        match result {
            Ok(()) => {
                journal.active_environment_id = None;
                let s = journal.servers.get_mut(&id).ok_or("Missing target")?;
                s.state = Phase::Ready;
                s.previous_policy = None;
                s.enrollment_attempt_id = None;
                s.message =
                    "Enrolled current helper; waiting for an idle-drained signed update".into();
            }
            Err(_) => {
                journal.hold(&id,Phase::Enrolling,"Enrollment could not be confirmed. Public-policy inspection only; the password is not retained.");
                journal.write(&setup.directory)?;
                return Ok(journal.status());
            }
        }
        journal.write(&setup.directory)?;
    }
    journal.enabled = true;
    journal.write(&setup.directory)?;
    Ok(journal.status())
}

struct PreparedUpdate {
    guard: UpdateGuard,
    review: Value,
    packet: Value,
    input: Vec<u8>,
    args: Vec<String>,
}
#[derive(Debug)]
enum PreSubmissionError {
    Recheck(String),
    Blocked(String),
}
impl From<String> for PreSubmissionError {
    fn from(message: String) -> Self {
        Self::Recheck(message)
    }
}
impl From<&str> for PreSubmissionError {
    fn from(message: &str) -> Self {
        Self::Recheck(message.into())
    }
}
fn pre_submission_failed(
    journal: &mut Journal,
    id: &str,
    error: PreSubmissionError,
) -> Result<(), String> {
    // This path is reachable only before any durable reservation or stage call.
    if journal.active_environment_id.is_some() {
        return Err("Cannot clear a reserved operation after a preflight error".into());
    }
    let server = journal.servers.get_mut(id).ok_or("Missing target")?;
    match error {
        PreSubmissionError::Recheck(message) => {
            server.state = Phase::Ready;
            server.message = format!("No maintenance request was submitted. {message} A fresh read-only check is required.");
            server.review_id = None;
            server.operation_id = None;
        }
        PreSubmissionError::Blocked(message) => {
            server.state = Phase::Blocked;
            server.message = message;
        }
    }
    Ok(())
}
fn validate_current_release(
    review: &Value,
    current: &Value,
    bytes: &[u8],
    publisher: &str,
) -> Result<Value, PreSubmissionError> {
    let signed =
        verify_authorization(current, Some(publisher)).map_err(PreSubmissionError::Blocked)?;
    verify_authorization(&review["artifact"], Some(publisher))
        .map_err(PreSubmissionError::Blocked)?;
    if review["artifact"] != *current {
        return Err("The bundled release changed since the saved check; discard that check, not an operation receipt".into());
    }
    if signed["sha256"] != sha(bytes) || signed["size"].as_u64() != Some(bytes.len() as u64) {
        return Err("Current bundled archive does not match the signed review".into());
    }
    Ok(signed)
}
async fn prepare_update(
    app: &tauri::AppHandle,
    setup: Arc<Setup>,
    state: Arc<State>,
    server: &Server,
) -> Result<PreparedUpdate, PreSubmissionError> {
    let environment = server.environment_id.clone();
    let guard = acquire(&environment)?;
    let review = load(&setup, &environment)?;
    if review["state"] != "review"
        || review["reviewId"].as_str() != server.review_id.as_deref()
        || review["operationId"].as_str() != server.operation_id.as_deref()
        || review["artifact"]["id"].as_str() != server.release_id.as_deref()
        || review["available"] != true
        || review["expiresAt"].as_u64().unwrap_or(0) < now()
    {
        return Err("Automatic review changed or expired before submission".into());
    }
    let expected = server.policy.clone().ok_or("Enrollment missing")?;
    let archive_name = review_archive(&review)?;
    let selected = if archive_name == ArtifactResource::Pi.archive() {
        ArtifactResource::Pi
    } else {
        ArtifactResource::Host
    };
    let current = bundled_artifact(app, selected)?.ok_or("Current bundled release unavailable")?;
    let archive = resource(app, archive_name)?;
    let bytes = fs::read(archive).map_err(|_| "Signed archive unavailable")?;
    let signed = validate_current_release(
        &review,
        &current,
        &bytes,
        expected["publisherPublicKey"]
            .as_str()
            .ok_or("Publisher pin missing")?,
    )?;
    let device = public_identity(&state)?;
    if expected["deviceId"] != device.0 || expected["environmentId"] != environment {
        return Err("Enrolled device identity changed".into());
    }
    let entry = setup.entry(review["setupId"].as_str().ok_or("Saved route missing")?)?;
    if expected["sshUser"] != entry.target.user {
        return Err("Enrolled SSH identity changed".into());
    }
    let observed = {
        let setup = setup.clone();
        let entry = entry.clone();
        tauri::async_runtime::spawn_blocking(move || inspect_policy(&setup, &entry))
            .await
            .map_err(|_| "Policy inspection interrupted")??
    };
    verify_current_helper(&expected, &observed).map_err(PreSubmissionError::Blocked)?;
    let packet = json!({"operationId":review["operationId"],"environmentId":environment,"deviceId":device.0,"releaseId":review["artifact"]["id"],"expectedRelease":review["installed"]["releaseId"],"sha256":signed["sha256"],"size":bytes.len(),"target":review["artifact"]["manifest"]});
    let mut input = {
        let mut client = state.client.lock().map_err(|_| "Identity lock failed")?;
        state.identity(&mut client)?;
        let identity = client
            .identity
            .as_ref()
            .ok_or("Device identity unavailable")?;
        if expected["deviceId"] != identity.id {
            return Err("Device identity changed".into());
        }
        sign_request(&packet, &review["artifact"]["authorization"], &identity.key)?
    };
    input.extend(bytes);
    let mut args = setup.ssh_args(&entry)?;
    args.extend(["--".into(), entry.target.host.clone(), LAUNCH.into()]);
    Ok(PreparedUpdate {
        guard,
        review,
        packet,
        input,
        args,
    })
}
async fn submit_update(
    setup: Arc<Setup>,
    state: Arc<State>,
    prepared: PreparedUpdate,
) -> Result<Value, String> {
    let PreparedUpdate {
        guard,
        mut review,
        packet,
        input,
        args,
    } = prepared;
    let environment = review["environmentId"]
        .as_str()
        .ok_or("Missing prepared environment")?
        .to_owned();
    review["state"] = json!("authorizing");
    save(&setup, &environment, &review)?;
    let stage=state.agent_request(json!({"type":"maintenance.stage","operationId":packet["operationId"],"expectedRelease":packet["expectedRelease"],"target":packet["target"],"sha256":packet["sha256"]})).await?;
    if stage["state"] != "staging"
        || stage["operationId"] != packet["operationId"]
        || stage["owner"] != packet["deviceId"]
        || stage["expectedRelease"] != packet["expectedRelease"]
        || stage["target"] != packet["target"]
        || stage["sha256"] != packet["sha256"]
    {
        return Err("Maintenance reservation binding changed".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        review["state"] = json!("unknown");
        save(&setup, &environment, &review)?;
        let result = run(
            setup.ssh_program(),
            &args,
            &input,
            Duration::from_secs(90),
            &AtomicBool::new(false),
        );
        apply_launch_result(&mut review, &environment, result);
        save(&setup, &environment, &review)?;
        Ok(review)
    })
    .await
    .map_err(|_| "Automatic launch interrupted; inspect only")?
}

#[tauri::command]
pub async fn automatic_updates_tick(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    connected_environment_ids: Vec<String>,
) -> Result<Value, String> {
    let _guard = acquire_global(&setup.directory)?;
    setup.ready()?;
    let mut journal = Journal::read(&setup.directory)?;
    if let Some(id) = journal.active_environment_id.clone() {
        reconcile(&app, setup.inner().clone(), &mut journal, &id).await?;
        journal.write(&setup.directory)?;
        return Ok(journal.status());
    }
    let bindings = registry.ssh_bindings()?;
    let connected: BTreeSet<_> = connected_environment_ids.into_iter().collect();
    let eligible: Vec<_> = bindings
        .iter()
        .filter(|(id, _)| connected.contains(id))
        .map(|(id, _)| id.clone())
        .collect();
    if eligible.is_empty() {
        return Ok(journal.status());
    }
    let id = eligible[journal.cursor % eligible.len()].clone();
    journal.cursor = journal.cursor.wrapping_add(1);
    journal
        .servers
        .entry(id.clone())
        .or_insert_with(|| Server::new(id.clone()));
    let previous = optional_review(&setup, &id)?;
    if let Some(review) = &previous {
        if retain_previous_review(review)
            || matches!(
                review["state"].as_str(),
                Some("failed" | "rolled_back" | "cancelled")
            )
        {
            adopt_receipt(&mut journal, &id, review)?;
            journal.write(&setup.directory)?;
            return Ok(journal.status());
        }
    }
    let server = journal.servers[&id].clone();
    if should_launch(&journal, &id, previous.as_ref(), now()) {
        unresolved_manual(&setup, None)?;
        let state = match registry.get(&id) {
            Ok(state) => state,
            Err(error) => {
                pre_submission_failed(&mut journal, &id, error.into())?;
                journal.write(&setup.directory)?;
                return Ok(journal.status());
            }
        };
        let prepared =
            match prepare_update(&app, setup.inner().clone(), state.clone(), &server).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    pre_submission_failed(&mut journal, &id, error)?;
                    journal.write(&setup.directory)?;
                    return Ok(journal.status());
                }
            };
        // All archive, signature, device, policy and SSH preflight checks have
        // finished. From this durable boundary onward, failures remain uncertain.
        journal.hold(
            &id,
            Phase::Authorizing,
            "Reserving signed maintenance; any interruption is inspect-only.",
        );
        journal.write(&setup.directory)?;
        let result = submit_update(setup.inner().clone(), state, prepared).await;
        match result {
            Ok(review)=>apply_progress(&mut journal,&id,&review)?,
            Err(_)=>journal.hold(&id,Phase::Unknown,"Update authorization or launch could not be confirmed. No automatic retry; inspect the retained operation."),
        }
    } else if !matches!(
        server.state,
        Phase::Failed | Phase::RolledBack | Phase::NeedsAttention
    ) {
        let result = check_inner(
            app.clone(),
            app.state::<Arc<Setup>>(),
            app.state::<environments::Registry>(),
            id.clone(),
        )
        .await;
        match result {
            Ok(review) => {
                if review["state"] != "review" {
                    journal.hold(&id,Phase::NeedsAttention,"An existing manual or uncertain operation owns this server. Inspect it before automatic updates.");
                } else {
                    let server = journal.servers.get_mut(&id).ok_or("Missing target")?;
                    server.message = review["message"]
                        .as_str()
                        .unwrap_or("Read-only update check completed")
                        .into();
                    server.review_id = review["reviewId"].as_str().map(String::from);
                    server.operation_id = review["operationId"].as_str().map(String::from);
                    server.release_id = review["artifact"]["id"].as_str().map(String::from);
                    server.state = Phase::Ready;
                    if review["available"] == true {
                        let pin = server
                            .policy
                            .as_ref()
                            .and_then(|p| p["publisherPublicKey"].as_str());
                        if verify_authorization(&review["artifact"], pin).is_ok() {
                            if let Some(error) = server
                                .policy
                                .as_ref()
                                .and_then(|policy| verify_current_helper(policy, policy).err())
                            {
                                server.state = Phase::Blocked;
                                server.message = error;
                            } else {
                                server.state = Phase::Checked;
                                server.message="Complete signed compatible release checked; awaiting serialized idle-drained update".into();
                            }
                        } else {
                            server.state = Phase::Blocked;
                            server.message="Unsigned, incomplete, or differently pinned release refused; manual review remains available".into();
                        }
                    }
                }
            }
            Err(_) => {
                let server = journal.servers.get_mut(&id).ok_or("Missing target")?;
                server.message = "Read-only check unavailable; no update launched".into();
                server.state = Phase::Ready;
            }
        }
    }
    journal.write(&setup.directory)?;
    Ok(journal.status())
}
fn should_launch(journal: &Journal, id: &str, review: Option<&Value>, time: u64) -> bool {
    let Some(server) = journal.servers.get(id) else {
        return false;
    };
    let Some(review) = review else { return false };
    journal.enabled
        && journal.active_environment_id.is_none()
        && journal.targets.iter().any(|target| target == id)
        && server.state == Phase::Checked
        && server.policy.is_some()
        && !journal.targets.iter().any(|target| {
            journal.servers.get(target).is_some_and(|s| {
                matches!(
                    s.state,
                    Phase::Failed | Phase::RolledBack | Phase::Blocked | Phase::NeedsAttention
                )
            })
        })
        && review["state"] == "review"
        && review["available"] == true
        && review["environmentId"] == id
        && review["reviewId"].as_str() == server.review_id.as_deref()
        && review["operationId"].as_str() == server.operation_id.as_deref()
        && review["artifact"]["id"].as_str() == server.release_id.as_deref()
        && review["expiresAt"]
            .as_u64()
            .is_some_and(|expiry| expiry >= time)
}
fn optional_review(setup: &Setup, id: &str) -> Result<Option<Value>, String> {
    match fs::symlink_metadata(path(setup, id)?) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => load(setup, id).map(Some),
        _ => Err("Update receipt unavailable; automatic queue is blocked".into()),
    }
}
fn adopt_receipt(journal: &mut Journal, id: &str, review: &Value) -> Result<(), String> {
    let operation = review["operationId"]
        .as_str()
        .ok_or("Incomplete receipt has no operation; queue blocked")?;
    environments::validate_id(operation)?;
    if review["environmentId"] != id {
        return Err("Retained receipt identity mismatch; queue blocked".into());
    }
    let server = journal.servers.get_mut(id).ok_or("Missing target")?;
    server.operation_id = Some(operation.into());
    server.review_id = review["reviewId"].as_str().map(String::from);
    server.release_id = review["artifact"]["id"].as_str().map(String::from);
    apply_progress(journal, id, review)
}
fn apply_progress(journal: &mut Journal, id: &str, review: &Value) -> Result<(), String> {
    let server = journal.servers.get(id).ok_or("Missing automatic target")?;
    if review["environmentId"] != id
        || review["operationId"].as_str() != server.operation_id.as_deref()
        || review["artifact"]["id"].as_str() != server.release_id.as_deref()
    {
        return Err("Automatic operation binding mismatch; queue held".into());
    }
    let (phase,message)=match review["state"].as_str() {
        Some("complete")=>(Phase::Verifying,"Host reports completion; independently verifying coordinator, worker, host and tools before releasing the queue"),
        Some("failed")=>(Phase::Failed,"Update failed. Queue held; no automatic retry"),
        Some("rolled_back")=>(Phase::RolledBack,"Update rolled back. Queue held; no automatic retry"),
        Some("queued"|"staging"|"waiting_for_idle"|"activating"|"recovering")=>(Phase::Updating,"Existing updater owns idle draining and recovery; inspecting only"),
        Some("needs_attention"|"cancelled")=>(Phase::NeedsAttention,"Existing operation needs manual attention; queue held"),
        _=>(Phase::Unknown,"Operation outcome uncertain; queue held and launch will not be repeated"),
    };
    journal.hold(id, phase, message);
    Ok(())
}
fn finish_enrollment_observation(
    journal: &mut Journal,
    id: &str,
    observed: &Value,
    terminal_previous: bool,
) -> Result<(), String> {
    if journal.active_environment_id.as_deref() != Some(id) {
        return Err("Enrollment observation does not own the queue".into());
    }
    let server = journal
        .servers
        .get_mut(id)
        .ok_or("Missing enrollment target")?;
    if server.state != Phase::Enrolling {
        return Err("Only enrollment receipts can release enrollment reservations".into());
    }
    let desired = server
        .policy
        .as_ref()
        .ok_or("Reserved enrollment policy missing")?;
    if observed == desired {
        journal.active_environment_id = None;
        server.state = Phase::Ready;
        server.previous_policy = None;
        server.enrollment_attempt_id = None;
        server.message =
            "Existing enrollment reconciled from pinned public policy; no root call repeated"
                .into();
    } else if terminal_previous && server.previous_policy.as_ref() == Some(observed) {
        // A terminal, bound helper receipt proves that this attempt cannot commit
        // later. This releases only the latch, never retries the privileged call.
        journal.active_environment_id = None;
        journal.enabled = false;
        server.policy = server.previous_policy.take();
        server.enrollment_attempt_id = None;
        server.state = Phase::Blocked;
        server.message = "Renewal ended without committing; the previous helper policy is intact. Automatic updates remain disabled. Enable them again for a new protected authorization; nothing was retried.".into();
    }
    Ok(())
}
async fn reconcile(
    app: &tauri::AppHandle,
    setup: Arc<Setup>,
    journal: &mut Journal,
    id: &str,
) -> Result<(), String> {
    let server = journal
        .servers
        .get(id)
        .ok_or("Missing reserved target")?
        .clone();
    if server.state == Phase::Enrolling {
        let registry = app.state::<environments::Registry>();
        let binding = registry
            .ssh_bindings()?
            .into_iter()
            .find(|(saved, _)| saved == id)
            .ok_or("Reserved enrollment route missing; queue held")?
            .1;
        let entry = setup.entry(&binding.setup_id)?;
        let result = tauri::async_runtime::spawn_blocking(move || {
            ssh_json(&setup, &entry, &enrollment_inspection_source()?, 15)
        })
        .await
        .map_err(|_| "Enrollment inspection interrupted")?;
        if let Ok(observation) = result {
            let previous_terminal =
                terminal_previous_renewal(&server, &observation["policy"], &observation["receipt"]);
            finish_enrollment_observation(journal, id, &observation["policy"], previous_terminal)?;
        }
        return Ok(());
    }
    if matches!(
        server.state,
        Phase::Failed | Phase::RolledBack | Phase::NeedsAttention | Phase::Blocked
    ) {
        return Ok(());
    }
    if server.state == Phase::Verifying {
        // Re-read the host receipt: a cached complete receipt cannot override a
        // later failure/rollback, even when the app was offline between ticks.
        let latest = match status_inner(
            app.state::<Arc<Setup>>(),
            app.state::<environments::Registry>(),
            id.into(),
        )
        .await
        {
            Ok(review) => review,
            Err(_) => {
                journal.hold(
                    id,
                    Phase::Verifying,
                    "Completion is unreachable; queue remains held for verification",
                );
                return Ok(());
            }
        };
        apply_progress(journal, id, &latest)?;
        if journal.servers[id].state != Phase::Verifying {
            return Ok(());
        }
        let result = postverify(app, setup, id, &server).await;
        finish_verification(journal, id, result)?;
        return Ok(());
    }
    match status_inner(app.state::<Arc<Setup>>(),app.state::<environments::Registry>(),id.into()).await {
        Ok(review)=>apply_progress(journal,id,&review)?,
        Err(_)=>journal.hold(id,Phase::Unknown,"Reserved operation is unreachable or uncertain. Inspect only; no other server will launch."),
    }
    Ok(())
}

fn finish_verification(
    journal: &mut Journal,
    id: &str,
    result: Result<(), String>,
) -> Result<(), String> {
    if journal.active_environment_id.as_deref() != Some(id)
        || !journal
            .servers
            .get(id)
            .is_some_and(|s| s.state == Phase::Verifying)
    {
        return Err("Verification no longer owns this queue reservation".into());
    }
    match result {
        Ok(()) => {
            let server = journal.servers.get_mut(id).ok_or("Missing target")?;
            server.state = Phase::Complete;
            server.message = "Verified coordinator, worker, qualified required tools and fresh stable services; queue released".into();
            journal.active_environment_id = None;
        }
        Err(message) => journal.hold(id, Phase::Verifying, &message),
    }
    Ok(())
}

const SERVICE_PROBE: &str = r#"import json,subprocess,time,urllib.request,urllib.error,pathlib,hashlib,re,stat
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs): raise ValueError('Redirect refused')
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
def public(path):
 s=path.lstat()
 if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode & 0o022 or path.resolve()!=path: raise ValueError('Unsafe public metadata')
 return path.read_bytes()
installation_path=pathlib.Path('/etc/outpost-native/installation.json')
installation_bytes=public(installation_path)
installation=json.loads(installation_bytes)
prefix=pathlib.Path('/opt/outpost-native');releases=prefix/'releases';current=(prefix/'current').resolve(strict=True)
if prefix.resolve()!=prefix or releases.resolve()!=releases or current.parent!=releases or not re.fullmatch(r'host-[a-f0-9]{20}',current.name): raise ValueError('Release path mismatch')
manifest_path=current/'host-manifest.json';pins_path=current/'deploy/environment/runtime-pins.json'
manifest_bytes=public(manifest_path);pins_bytes=public(pins_path);manifest=json.loads(manifest_bytes)
if manifest['id']!=current.name or installation['release']!=current.name: raise ValueError('Current release mismatch')
units=['outpost-native-worker.service','outpost-native-coordinator.service']
if installation.get('fullControl'): units.append('outpost-native-host.service')
def sample():
 result=[]
 for unit in units:
  p=subprocess.run(['/usr/bin/systemctl','show',unit,'--no-pager','--property=ActiveState,SubState,MainPID,NRestarts'],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=5,check=True)
  if len(p.stdout)>4096: raise ValueError('Invalid service response')
  v=dict(line.split('=',1) for line in p.stdout.decode().splitlines() if '=' in line)
  pid,restarts=int(v.get('MainPID','0')),int(v.get('NRestarts','-1'))
  if v.get('ActiveState')!='active' or v.get('SubState')!='running' or pid<=0 or restarts<0: raise ValueError('Unstable service')
  result.append({'unit':unit,'pid':pid,'restarts':restarts})
 return result
first=sample();started=time.monotonic()
for _ in range(4):
 time.sleep(2)
 if sample()!=first: raise ValueError('Services restarted during observation')
def read_env_port(path,var,default):
 try:
  s=path.lstat()
  if not stat.S_ISREG(s.st_mode) or s.st_uid!=0 or s.st_mode & 0o022 or path.resolve()!=path: return default
  raw=path.read_bytes()
 except (OSError,KeyError):
  return default
 if len(raw)>65536: return default
 found=None
 for line in raw.decode('utf-8',errors='replace').splitlines():
  line=line.strip()
  if not line or line.startswith(('#',';')) or '=' not in line: continue
  key,val=line.split('=',1)
  if key.strip()!=var: continue
  val=val.strip()
  if len(val)>=2 and val[0]==val[-1] and val[0] in ('"',"'"): val=val[1:-1]
  if re.fullmatch(r'[0-9]{1,5}',val) and 1<=int(val)<=65535: found=int(val)
  else: found=None
 return default if found is None else found
if installation.get('fullControl'):
 host_port=read_env_port(pathlib.Path('/etc/outpost-native/host.env'),'OUTPOST_HOST_PORT',4519)
 with opener.open(f'http://127.0.0.1:{host_port}/health',timeout=2) as response:
  v=json.loads(response.read(32768))
  if v.get('ready') is not True or v.get('host')!='local': raise ValueError('Host listener mismatch')
 try:
  opener.open(f'http://127.0.0.1:{host_port}/outpost-update-auth-probe',timeout=2)
  raise ValueError('Host authentication not enforced')
 except urllib.error.HTTPError as error:
  if error.code!=401: raise ValueError('Host auth challenge mismatch')
  error.close()
if (prefix/'current').resolve(strict=True)!=current or public(installation_path)!=installation_bytes or public(manifest_path)!=manifest_bytes or public(pins_path)!=pins_bytes: raise ValueError('Release changed during observation')
print(json.dumps({'environmentId':installation['environmentId'],'releaseId':current.name,'manifest':manifest,'runtimePinsSha256':hashlib.sha256(pins_bytes).hexdigest(),'services':first,'stableSeconds':time.monotonic()-started,'observations':5,'hostAuthEnforced':bool(installation.get('fullControl')),'fullControl':bool(installation.get('fullControl'))}))
"#;
fn verify_completion_receipt(review: &Value, server: &Server, id: &str) -> Result<(), String> {
    if server.release_id.is_none()
        || server.operation_id.is_none()
        || !bound_host_receipt(review, &review["progress"], id)
        || review["hostStatusVerified"] != true
        || review["progress"]["state"] != "complete"
        || review["progress"]["releaseId"].as_str() != server.release_id.as_deref()
        || review["artifact"]["id"].as_str() != server.release_id.as_deref()
        || review["state"] != "complete"
        || review["operationId"].as_str() != server.operation_id.as_deref()
    {
        return Err("Completion receipt binding unavailable; queue held".into());
    }
    Ok(())
}
struct LiveVerification<'a> {
    environment: &'a Value,
    runtime: &'a Value,
    inventory: &'a Value,
    services: &'a Value,
    tools: Option<&'a Value>,
}

fn tools_cover(required: &Value, qualified: &Value, limit: usize) -> bool {
    let (Some(required), Some(qualified)) = (required.as_array(), qualified.as_array()) else {
        return false;
    };
    let names: Option<BTreeSet<&str>> = qualified.iter().map(Value::as_str).collect();
    names.is_some_and(|names| {
        qualified.len() <= limit
            && names.len() == qualified.len()
            && names
                .iter()
                .all(|name| !name.is_empty() && name.len() <= 128)
            && required
                .iter()
                .all(|name| name.as_str().is_some_and(|name| names.contains(name)))
    })
}

fn healthy_services(services: &Value, full_control: bool) -> bool {
    let Some(services) = services.as_array() else {
        return false;
    };
    let mut units = vec![
        "outpost-native-worker.service",
        "outpost-native-coordinator.service",
    ];
    if full_control {
        units.push("outpost-native-host.service");
    }
    services.len() == units.len()
        && units
            .iter()
            .all(|unit| services.iter().any(|s| s["unit"] == *unit))
        && services.iter().all(|s| {
            s["pid"].as_u64().is_some_and(|pid| pid > 0) && s["restarts"].as_u64().is_some()
        })
}

fn verify_postupdate_health(
    review: &Value,
    server: &Server,
    id: &str,
    live: LiveVerification<'_>,
) -> Result<(), String> {
    verify_completion_receipt(review, server, id)?;
    let pin = server
        .policy
        .as_ref()
        .and_then(|policy| policy["publisherPublicKey"].as_str())
        .ok_or("Enrolled publisher pin missing; queue held")?;
    let signed = verify_authorization(&review["artifact"], Some(pin))?;
    let release = &signed["manifest"]["id"];
    if live.environment["environmentId"] != id
        || live.environment["runtime"]["release"] != *release
        || live.inventory["manifest"] != signed["manifest"]
        || live.inventory["releaseId"] != *release
        || live.runtime["piManagement"] != true
    {
        return Err("Coordinator/worker release verification failed; queue held".into());
    }
    let health = &review["progress"]["health"];
    // The pinned root updater qualified the actual installed Coordinator catalogue
    // in an isolated fixture. No production task or task history is required.
    if health["releaseId"] != *release
        || !health["stableSeconds"].as_u64().is_some_and(|n| n >= 8)
        || !tools_cover(&signed["requiredTools"], &health["requiredTools"], 128)
    {
        return Err("Bound root completion lacks verified required-tool/health evidence; queue held without relaunching".into());
    }
    if let Some(tools) = live.tools {
        let names = tools
            .as_array()
            .map(|tools| Value::Array(tools.iter().map(|tool| tool["name"].clone()).collect()))
            .unwrap_or(Value::Null);
        if !tools_cover(&signed["requiredTools"], &names, 1024) {
            return Err(
                "Available live tool catalogue contradicts required tools; queue held".into(),
            );
        }
    }
    let observed = live.services;
    let full_control = observed["fullControl"]
        .as_bool()
        .ok_or("Invalid fresh service observation; queue held")?;
    // Reboots legitimately change PIDs and reset restart counters. Both observations
    // must be healthy, but only the fresh probe's own bounded window must be stable.
    if observed["environmentId"] != id
        || observed["releaseId"] != *release
        || observed["manifest"] != signed["manifest"]
        || observed["runtimePinsSha256"] != signed["runtimePinsSha256"]
        || !observed["stableSeconds"]
            .as_f64()
            .is_some_and(|n| n.is_finite() && n >= 8.0)
        || !observed["observations"].as_u64().is_some_and(|n| n >= 5)
        || !healthy_services(&observed["services"], full_control)
        || !healthy_services(&health["services"], full_control)
        || live.runtime["hostAdministration"].as_bool() != Some(full_control)
        || (full_control && observed["hostAuthEnforced"] != true)
    {
        return Err(
            "Fresh release/service/host authentication verification failed; queue held".into(),
        );
    }
    Ok(())
}

async fn postverify(
    app: &tauri::AppHandle,
    setup: Arc<Setup>,
    id: &str,
    server: &Server,
) -> Result<(), String> {
    let registry = app.state::<environments::Registry>();
    let state = registry.get(id)?;
    let review = load(&setup, id)?;
    verify_completion_receipt(&review, server, id)?;

    let environment = environments::query_value(&state, "environment".into(), json!({}))
        .await
        .map_err(|_| "Authenticated coordinator verification unavailable; queue held")?;
    let runtime = environments::query_value(&state, "runtime".into(), json!({}))
        .await
        .map_err(|_| "Authenticated runtime verification unavailable; queue held")?;
    let inventory = state
        .agent_request(json!({"type":"runtime.inventory"}))
        .await
        .map_err(|_| "Authenticated worker verification unavailable; queue held")?;
    // This server API has no task-independent Gate catalogue endpoint. An existing
    // task provides an optional stronger check; absent/inaccessible history does not
    // invalidate the bound root qualification. Never create a task to probe tools.
    let snapshot = environments::query_value(&state, "snapshot".into(), json!({}))
        .await
        .ok();
    let task = snapshot
        .as_ref()
        .and_then(|snapshot| snapshot["records"].as_array())
        .and_then(|records| records.iter().find(|r| r["kind"] == "task"))
        .and_then(|record| record["id"].as_str());
    let tools = if let Some(task) = task {
        environments::query_value(&state, "tools".into(), json!({"taskId":task}))
            .await
            .ok()
    } else {
        None
    };
    let entry = setup.entry(
        review["setupId"]
            .as_str()
            .ok_or("Saved verification route missing")?,
    )?;
    let observed =
        tauri::async_runtime::spawn_blocking(move || ssh_json(&setup, &entry, SERVICE_PROBE, 45))
            .await
            .map_err(|_| "Service verification interrupted; queue held")??;
    verify_postupdate_health(
        &review,
        server,
        id,
        LiveVerification {
            environment: &environment,
            runtime: &runtime,
            inventory: &inventory,
            services: &observed,
            tools: tools.as_ref(),
        },
    )
}

#[cfg(test)]
#[path = "server_auto_update_tests.rs"]
mod tests;

fn validate_failed_recovery(review: &Value, environment: &str, owner: &str, maintenance: &Value, host: &Value) -> Result<(), String> {
    let operation = review["operationId"].as_str().ok_or("Missing retained operation")?;
    environments::validate_id(operation)?;
    if review["state"] != "failed" || review["progress"]["failureStage"] != "waiting_for_idle"
        || review["progress"]["failureCode"] != "waiting_for_idle_failed"
        || maintenance["operationId"] != operation || maintenance["owner"] != owner
        || maintenance["state"] != "cancelled" || maintenance["sha256"] != review["artifact"]["sha256"]
        || host["environmentId"] != environment || host["operationId"] != operation
        || host["expectedRelease"] != review["installed"]["releaseId"]
        || host["sha256"] != review["artifact"]["sha256"] || host["state"] != "safe_to_recheck"
        || ![Some("inactive"), Some("failed")].contains(&host["updaterState"].as_str()) {
        return Err("Recovery refused: the failed operation, released maintenance hold, stopped updater and previous release must all agree".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn automatic_updates_recover(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: String,
    approved: bool,
    password: bool,
) -> Result<Value, String> {
    if !approved { return Err("Recovery must be explicitly requested".into()); }
    let _global = acquire_global(&setup.directory)?;
    let mut journal = Journal::read(&setup.directory)?;
    if journal.active_environment_id.as_deref().is_some_and(|id| id != environment_id) {
        return Err("Another server owns the update queue".into());
    }
    let review = load(&setup, &environment_id)?;
    if review["state"] != "failed" || review["progress"]["failureCode"] != "waiting_for_idle_failed" {
        return Err("Only a verified pre-activation idle timeout can use this recovery".into());
    }
    let state = registry.get(&environment_id)?;
    let owner = public_identity(&state)?.0;
    let maintenance = state.agent_request(json!({"type":"maintenance.status"})).await?;
    if maintenance["state"] != "cancelled" || maintenance["owner"] != owner
        || maintenance["operationId"] != review["operationId"] || maintenance["sha256"] != review["artifact"]["sha256"]
        {
        return Err("The coordinator has not confirmed a released maintenance hold on the previous release; nothing was cleared".into());
    }
    let entry = setup.entry(review["setupId"].as_str().ok_or("Saved SSH route missing")?)?;
    let operation = review["operationId"].as_str().ok_or("Operation missing")?;
    environments::validate_id(operation)?;
    let params = [environment_id.as_str(), operation, review["installed"]["releaseId"].as_str().ok_or("Previous release missing")?, review["artifact"]["sha256"].as_str().ok_or("Release digest missing")?];
    let source = format!("{}\n", include_str!("../../../deploy/environment/inspect_failed_update.py"));
    let root = entry.inspection.as_ref().is_some_and(|v| v.uid == 0);
    let command = format!("{}{} {}", if root { "" } else if password { "sudo -k -S -p '' -- " } else { "sudo -n -- " }, isolated_python(&source), params.iter().map(|value| format!("'{}'", value.replace('\'', "'\\''"))).collect::<Vec<_>>().join(" "));
    let mut args = setup.ssh_args(&entry)?;
    args.extend(["--".into(), entry.target.host.clone(), command]);
    let host = tauri::async_runtime::spawn_blocking(move || -> Result<Value, String> {
        let mut input = zeroize::Zeroizing::new(Vec::new());
        if !root && password {
            let prompt = serde_json::to_string(&format!("Inspect the stopped Outpost update on {}@{}. This read-only check does not restart services. The password is not saved.", entry.target.user, entry.target.host)).map_err(|_| "Invalid prompt")?;
            let script = format!("text returned of (display dialog {prompt} default answer \"\" with hidden answer buttons {{\"Cancel\",\"Inspect update\"}} default button \"Inspect update\" with title \"Outpost recovery\")");
            let mut secret = zeroize::Zeroizing::new(run("/usr/bin/osascript", &["-e".into(), script], b"", Duration::from_secs(180), &AtomicBool::new(false))?);
            while matches!(secret.last(), Some(b'\n' | b'\r')) { secret.pop(); }
            if secret.is_empty() || secret.len() > 1024 || secret.contains(&b'\n') { return Err("Invalid authorization input".into()); }
            input.extend_from_slice(&secret); input.push(b'\n'); secret.fill(0);
        }
        let bytes = run("/usr/bin/ssh", &args, &input, Duration::from_secs(30), &AtomicBool::new(false)).map_err(|_| "Host inspection could not be verified; nothing was cleared")?;
        serde_json::from_slice(&bytes).map_err(|_| "Invalid host inspection".into())
    }).await.map_err(|_| "Recovery inspection interrupted")??;
    // Read authenticated coordinator state again after the privileged host probe.
    let maintenance_after = state.agent_request(json!({"type":"maintenance.status"})).await?;
    validate_failed_recovery(&review, &environment_id, &owner, &maintenance, &host)?;
    validate_failed_recovery(&review, &environment_id, &owner, &maintenance_after, &host)?;
    let archive = setup.directory.join(format!("recovered-update-{}-{}.json", environment_id, operation));
    private_write(&archive, &serde_json::to_vec(&review).map_err(|_| "Invalid recovery archive")?)?;
    let server = journal.servers.get_mut(&environment_id).ok_or("Server journal missing")?;
    server.state = Phase::Ready; server.operation_id = None; server.review_id = None;
    server.message = "Verified stopped pre-activation failure; retained receipt archived; checking a fresh update".into();
    journal.active_environment_id = None;
    journal.write(&setup.directory)?;
    // Keeping the old failed receipt until the new check succeeds makes an interruption fail closed.
    check_inner(app, setup, registry, environment_id).await?;
    Ok(journal.status())
}

#[cfg(test)]
mod failed_recovery_tests {
    use super::*;
    fn evidence() -> (Value, Value, Value, Value) {
        let review = json!({"state":"failed","operationId":"33abaf6c-63dd-4977-a0c9-fba36a2b874b","progress":{"failureStage":"waiting_for_idle","failureCode":"waiting_for_idle_failed"},"artifact":{"sha256":"digest"},"installed":{"releaseId":"previous"}});
        let maintenance = json!({"operationId":review["operationId"],"owner":"device","state":"cancelled","sha256":"digest"});
        let inventory = json!({"releaseId":"previous"});
        let host = json!({"environmentId":"environment","operationId":review["operationId"],"expectedRelease":"previous","sha256":"digest","state":"safe_to_recheck","updaterState":"inactive"});
        (review, maintenance, inventory, host)
    }
    #[test]
    fn recovery_requires_every_bound_piece_of_live_evidence() {
        let (review, maintenance, _inventory, host) = evidence();
        assert!(validate_failed_recovery(&review,"environment","device",&maintenance,&host).is_ok());
        for key in ["operationId", "owner", "state", "sha256"] {
            let mut bad=maintenance.clone(); bad[key]=json!("changed");
            assert!(validate_failed_recovery(&review,"environment","device",&bad,&host).is_err(),"{key}");
        }
        for key in ["environmentId", "operationId", "expectedRelease", "sha256", "state", "updaterState"] {
            let mut bad=host.clone(); bad[key]=json!("changed");
            assert!(validate_failed_recovery(&review,"environment","device",&maintenance,&bad).is_err(),"{key}");
        }
        for state in ["unknown","staging","activating","rolled_back","complete","needs_attention"] {
            let mut bad=review.clone(); bad["state"]=json!(state);
            assert!(validate_failed_recovery(&bad,"environment","device",&maintenance,&host).is_err(),"{state}");
        }

    }
}
