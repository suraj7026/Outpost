//! Separately authorized disposal of a verified native operation; never installation resume.
use super::*;
use ::zeroize::Zeroizing;
use history::{ActivityGuard, ActivityKind};
use std::collections::BTreeSet;

#[path = "native_authorization.rs"]
mod authorization;
use authorization::Error as AuthorizationError;

#[path = "server_restart_journal.rs"]
mod journal;
pub(super) use journal::Journal;
#[cfg(test)]
#[path = "server_restart_recovery.rs"]
mod recovery;
#[cfg(test)]
#[path = "server_restart_tests.rs"]
mod tests;

const HELPER: &str = include_str!("setup_restart_helper.py");
const BOOTSTRAP: &str = include_str!("setup_restart_bootstrap.py");
const MAX_HELPER_BYTES: usize = 1024 * 1024;
const MAX_PACKET: usize = 16 * 1024;
const MAX_RESTART_COMMAND: usize = 8 * 1024;
const PASSWORD_PRIVILEGE: &str = "sudo -k -S -p '' -- ";
const TTL: u64 = 300_000;
const MAX_REPLY: usize = 48 * 1024;
const REQUEST_CANCELLED: &str = "[restartRequest:requestCancel] The application cancelled the restart request; this is not a native prompt Cancel response.";
const REQUEST_REPLACED: &str = "[restartRequest:requestReplaced] The restart request no longer owns its activity reservation. Review again.";
const SUPERVISOR_UNAVAILABLE: &str = "[restartRequest:supervisorUnavailable] The desktop connection supervisor is unavailable or stopping.";
const TARGET_UNVERIFIED: &str = "[restartRequest:targetUnverified] The saved restart target, original operation or pinned trust could not be revalidated. Review again.";
const TRANSPORT_UNAVAILABLE: &str = "[restartRequest:transportUnavailable] The local SSH identity or pinned transport configuration is unavailable.";
const HOLD: &str = "This setup is held or retired by a restart. Check restart outcome; never replay its installation.";
const PATHS: [&str; 3] = [
    "/opt/outpost-native",
    "/etc/outpost-native",
    "/var/lib/outpost-native",
];
const SERVICES: [&str; 3] = [
    "outpost-native-worker.service",
    "outpost-native-coordinator.service",
    "outpost-native-host.service",
];
const ACCOUNTS: [&str; 7] = [
    "user:outpost-coord",
    "user:outpost-pi",
    "user:outpost-build",
    "group:outpost-coord",
    "group:outpost-pi",
    "group:outpost-build",
    "group:outpost-workspaces",
];

pub(super) fn canonical_host(host: &str) -> String {
    host.parse::<std::net::IpAddr>()
        .map(|v| v.to_string())
        .unwrap_or_else(|_| host.trim_end_matches('.').to_ascii_lowercase())
}
pub(super) fn same_host(a: &Target, b: &Target) -> bool {
    a.port == b.port && canonical_host(&a.host) == canonical_host(&b.host)
}
fn same_owner(a: &Entry, b: &Entry) -> bool {
    same_host(&a.target, &b.target) && !a.fingerprint.is_empty() && a.fingerprint == b.fingerprint
}
fn affected_setup_ids(inner: &Inner, binding: &Binding) -> BTreeSet<String> {
    inner
        .entries
        .values()
        .filter(|entry| {
            same_host(&binding.target, &entry.target)
                || entry
                    .plan
                    .as_ref()
                    .is_some_and(|p| p.environment_id == binding.expected.environment_id)
                || entry
                    .inspection
                    .as_ref()
                    .and_then(|i| i.environment.as_ref())
                    .is_some_and(|e| e.environment_id == binding.expected.environment_id)
        })
        .map(|entry| entry.id.clone())
        .collect()
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    operation_id: String,
    environment_id: String,
    release_id: String,
    sha256: String,
    size: u64,
    device_id: String,
    public_key: String,
}
impl Expected {
    fn from_entry(entry: &Entry) -> Result<Self, String> {
        let plan = entry
            .plan
            .as_ref()
            .ok_or("No original native installation plan is saved")?;
        plan.validate()?;
        if entry.installation.as_ref().is_some_and(|p| {
            p.operation_id != plan.operation_id
                || p.environment_id != plan.environment_id
                || p.release_id != plan.release_id
        }) {
            return Err("Original installation receipt and plan disagree".into());
        }
        Ok(Self {
            operation_id: plan.operation_id.clone(),
            environment_id: plan.environment_id.clone(),
            release_id: plan.release_id.clone(),
            sha256: plan.sha256.clone(),
            size: plan.size,
            device_id: plan.device_id.clone(),
            public_key: plan.public_key.clone(),
        })
    }
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Binding {
    id: String,
    source_id: String,
    target: Target,
    fingerprint: String,
    source_plan: Value,
    source_progress: Value,
    working_plan: Value,
    working_inspection: Value,
    expected: Expected,
}
impl Binding {
    fn new(working: &Entry, source: &Entry) -> Result<Self, String> {
        working.target.validate()?;
        source.target.validate()?;
        if !same_owner(working, source) {
            return Err("Choose an original operation with the same canonical SSH host, port and verified fingerprint".into());
        }
        Ok(Self {
            id: working.id.clone(),
            source_id: source.id.clone(),
            target: working.target.clone(),
            fingerprint: working.fingerprint.clone(),
            source_plan: serde_json::to_value(&source.plan).map_err(|_| "Invalid plan")?,
            source_progress: serde_json::to_value(&source.installation)
                .map_err(|_| "Invalid receipt")?,
            working_plan: serde_json::to_value(&working.plan).map_err(|_| "Invalid plan")?,
            working_inspection: serde_json::to_value(&working.inspection)
                .map_err(|_| "Invalid inspection")?,
            expected: Expected::from_entry(source)?,
        })
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartCandidate {
    id: String,
    label: String,
    operation_id: String,
    environment_id: String,
    state: String,
    completed_steps: u8,
    total_steps: u8,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartReview {
    review_id: String,
    reset_id: String,
    source_id: String,
    host: String,
    operation_id: String,
    environment_id: String,
    release_id: String,
    expires_at: u64,
    paths: Vec<String>,
    services: Vec<String>,
    accounts: Vec<String>,
    preserved: Vec<String>,
    warnings: Vec<String>,
    blockers: Vec<String>,
    can_reset: bool,
    state: String,
    completed_steps: u8,
    total_steps: u8,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartResult {
    state: String,
    reset_id: String,
    entry: Option<Entry>,
    message: String,
}
impl RestartResult {
    fn held(reset_id: &str, state: &str) -> Self {
        Self { state: state.into(), reset_id: reset_id.into(), entry: None,
            message: "Restart is not confirmed complete. The original setup remains fenced. Check restart outcome; do not repeat cleanup or installation.".into() }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireReview {
    schema_version: u8,
    reset_id: String,
    operation_id: String,
    environment_id: String,
    release_id: String,
    snapshot_digest: String,
    paths: Vec<String>,
    services: Vec<String>,
    accounts: Vec<String>,
    preserved: Vec<String>,
    warnings: Vec<String>,
    blockers: Vec<String>,
    can_reset: bool,
    state: String,
    completed_steps: u8,
    total_steps: u8,
    #[serde(default)]
    recovery_token: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireResult {
    schema_version: u8,
    reset_id: String,
    operation_id: String,
    environment_id: String,
    release_id: String,
    state: String,
    message: String,
}
#[derive(Clone)]
pub(super) struct CachedReview {
    binding: Binding,
    review: RestartReview,
    snapshot_digest: String,
    recovery_token: Option<String>,
    #[cfg(test)]
    recovery_pending: Option<journal::Pending>,
    #[cfg(test)]
    recovery_registry: Option<Value>,
    created: Instant,
}
impl CachedReview {
    pub(super) fn belongs_to(&self, id: &str) -> bool {
        self.binding.id == id || self.binding.source_id == id
    }
    fn normal(&self) -> Result<(), String> {
        if self.recovery_token.is_some() {
            return Err("Recovery review cannot authorize a normal restart".into());
        }
        Ok(())
    }
    fn current(&self) -> Result<(), String> {
        if self.review.expires_at <= now() || self.created.elapsed() >= Duration::from_millis(TTL) {
            return Err("Restart review expired. Review again before authorizing removal.".into());
        }
        if !self.review.can_reset || !self.review.blockers.is_empty() {
            return Err("Resolve restart blockers and review again".into());
        }
        Ok(())
    }
}
struct Request {
    guard: ActivityGuard,
    binding: Binding,
    reset_id: String,
    password: bool,
    #[cfg(test)]
    recovery_pending: Option<journal::Pending>,
}
struct ApplyRequest {
    request: Request,
    cached: CachedReview,
}
enum StatusResolution {
    None(ActivityGuard),
    Pending(Request),
}

fn bounded_text(values: &[String]) -> bool {
    values.len() <= 32
        && values
            .iter()
            .all(|v| !v.is_empty() && v.len() <= 1000 && !v.chars().any(char::is_control))
}
fn fixed_subset(values: &[String], allowed: &[&str]) -> bool {
    values.len() <= allowed.len()
        && values.iter().all(|v| allowed.contains(&v.as_str()))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}
fn digest_valid(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
fn recovery_token_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn identity_matches(
    schema: u8,
    reset: &str,
    operation: &str,
    environment: &str,
    release: &str,
    request: &Request,
) -> bool {
    schema == 1
        && reset == request.reset_id
        && operation == request.binding.expected.operation_id
        && environment == request.binding.expected.environment_id
        && release == request.binding.expected.release_id
}
fn parse_review(bytes: &[u8], request: &Request) -> Result<CachedReview, String> {
    let w: WireReview =
        serde_json::from_slice(bytes).map_err(|_| "Invalid restart review protocol")?;
    if w.recovery_token.is_some() {
        return Err("Recovery token is not allowed in a normal restart review".into());
    }
    validate_review(w, request)
}
fn validate_review(w: WireReview, request: &Request) -> Result<CachedReview, String> {
    if !identity_matches(
        w.schema_version,
        &w.reset_id,
        &w.operation_id,
        &w.environment_id,
        &w.release_id,
        request,
    ) || !digest_valid(&w.snapshot_digest)
        || w.paths.len() != PATHS.len()
        || !fixed_subset(&w.paths, &PATHS)
        || !fixed_subset(&w.services, &SERVICES)
        || !fixed_subset(&w.accounts, &ACCOUNTS)
        || !bounded_text(&w.preserved)
        || !bounded_text(&w.warnings)
        || !bounded_text(&w.blockers)
        || w.total_steps != 12
        || w.completed_steps > 12
        || ![
            "queued",
            "running",
            "unknown",
            "authorizing",
            "failed",
            "cancelled",
            "interrupted",
            "ready",
            "complete",
        ]
        .contains(&w.state.as_str())
        || w.can_reset && !w.blockers.is_empty()
    {
        return Err("Restart review identity, scope or inactivity is not verified".into());
    }
    Ok(CachedReview {
        binding: request.binding.clone(),
        snapshot_digest: w.snapshot_digest,
        recovery_token: w.recovery_token,
        #[cfg(test)]
        recovery_pending: None,
        #[cfg(test)]
        recovery_registry: None,
        created: Instant::now(),
        review: RestartReview {
            review_id: Uuid::new_v4().to_string(),
            reset_id: w.reset_id,
            source_id: request.binding.source_id.clone(),
            host: request.binding.target.host.clone(),
            operation_id: w.operation_id,
            environment_id: w.environment_id,
            release_id: w.release_id,
            expires_at: now() + TTL,
            paths: w.paths,
            services: w.services,
            accounts: w.accounts,
            preserved: w.preserved,
            warnings: w.warnings,
            blockers: w.blockers,
            can_reset: w.can_reset,
            state: w.state,
            completed_steps: w.completed_steps,
            total_steps: w.total_steps,
        },
    })
}
fn public_message_valid(message: &str) -> bool {
    !message.is_empty() && message.len() <= 1000 && !message.chars().any(char::is_control)
}
fn parse_result(bytes: &[u8], request: &Request) -> Result<WireResult, String> {
    let w: WireResult =
        serde_json::from_slice(bytes).map_err(|_| "Invalid restart result protocol")?;
    if !identity_matches(
        w.schema_version,
        &w.reset_id,
        &w.operation_id,
        &w.environment_id,
        &w.release_id,
        request,
    ) || !["complete", "unknown", "failed"].contains(&w.state.as_str())
        || !public_message_valid(&w.message)
    {
        return Err("Restart outcome identity is not verified".into());
    }
    Ok(w)
}
fn helper_command() -> Result<String, String> {
    helper_command_for(HELPER.as_bytes())
}
fn helper_command_for(source: &[u8]) -> Result<String, String> {
    if source.is_empty() || source.len() > MAX_HELPER_BYTES {
        return Err(
            "[restartTransport:sourceLimit] The bundled restart helper exceeds the source budget."
                .into(),
        );
    }
    let command = format!(
        "/usr/bin/python3 -I -B -S -c 'import base64;exec(compile(base64.b64decode(\"{}\"),\"<outpost-restart-bootstrap>\",\"exec\"))' {} {:x}",
        STANDARD.encode(BOOTSTRAP), source.len(), Sha256::digest(source)
    );
    // Only the small loader and trusted metadata travel in argv, regardless of helper growth.
    if command.len() + PASSWORD_PRIVILEGE.len() >= MAX_RESTART_COMMAND {
        return Err(
            "[restartTransport:commandLimit] The restart bootstrap exceeds the command budget."
                .into(),
        );
    }
    Ok(command)
}
fn helper_frame(
    mut password: Zeroizing<Vec<u8>>,
    source: &[u8],
    packet: &[u8],
) -> Result<Zeroizing<Vec<u8>>, String> {
    if source.is_empty() || source.len() > MAX_HELPER_BYTES || packet.len() >= MAX_PACKET {
        return Err(
            "[restartTransport:frameLimit] The restart source or packet exceeds its input budget."
                .into(),
        );
    }
    if !password.is_empty()
        && (password.len() > 1025
            || password.last() != Some(&b'\n')
            || password[..password.len() - 1]
                .iter()
                .any(|b| *b < 32 || *b == 127))
    {
        return Err(
            "[restartTransport:passwordFrame] Invalid native authorization framing.".into(),
        );
    }
    // Allocate once before copying any password bytes: Vec growth must not leave secret
    // data in an unwiped prior allocation. The raw source has no extra delimiter.
    let mut payload = Zeroizing::new(Vec::with_capacity(
        password.len() + source.len() + packet.len() + 1,
    ));
    payload.extend_from_slice(&password);
    password.fill(0);
    payload.extend_from_slice(source);
    payload.extend_from_slice(packet);
    payload.push(b'\n');
    Ok(payload)
}
fn authorize(
    entry: &Entry,
    mode: &str,
    password: bool,
    cancel: &AtomicBool,
) -> Result<Zeroizing<Vec<u8>>, AuthorizationError> {
    authorization::prompt(
        authorization::Purpose::from_mode(mode)?,
        &format!(
            "{}@{}:{}",
            entry.target.user, entry.target.host, entry.target.port
        ),
        password,
        cancel,
    )
    .map(authorization::Secret::into_input)
}

fn helper_timeout(mode: &str) -> Duration {
    // Preserve the ten-second transport grace and bootstrap's ten-second source deadline.
    Duration::from_secs(
        20 + match mode {
            "apply" | "recover_apply" => 300,
            "review" | "recover_review" => 120,
            "stop" => 30,
            _ => 10,
        },
    )
}
fn server_execution_error(mode: &str) -> &'static str {
    match mode {
        "review" => "[serverExecution:review] The protected server review did not complete. The failing component (SSH transport, sudo or helper) is not identified; this is not a local authorization cancellation. No cleanup was requested.",
        "stop" => "[serverExecution:stop] The server stop request is not confirmed. The failing component (SSH transport, sudo or helper) is not identified. Review again; no cleanup was requested.",
        "recover_review" => "[serverExecution:recover_review] Recovery preparation is not confirmed. Check the same restart outcome; no cleanup was requested.",
        "recover_apply" => "[serverExecution:recover_apply] The server recovery cleanup outcome is unknown. Check the same restart outcome; do not replay cleanup.",
        "apply" => "[serverExecution:apply] The server cleanup outcome is unknown. The failing component (SSH transport, sudo or helper) is not identified. Check restart outcome; do not replay cleanup.",
        _ => "[serverExecution:status] The server outcome read did not complete. The failing component (SSH transport or helper) is not identified. Check restart outcome again.",
    }
}

impl Setup {
    fn restart_binding(&self, id: &str, source_id: &str) -> Result<Binding, String> {
        let working = self.entry(id)?;
        let source = self.entry(source_id)?;
        self.pinned_ssh_args(&working)?;
        // Original username/key may be obsolete. Verify its saved trust, never connect with it.
        self.pinned_ssh_args(&source)?;
        Binding::new(&working, &source)
    }
    fn restart_candidates(&self, id: &str) -> Result<Vec<RestartCandidate>, String> {
        let working = self.entry(id)?;
        self.pinned_ssh_args(&working)?;
        let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let mut result = Vec::new();
        for source in inner.entries.values() {
            if !same_owner(&working, source)
                || source.plan.is_none()
                || Self::restart_allowed(&inner, source).is_err()
            {
                continue;
            }
            if self.pinned_ssh_args(source).is_err() {
                continue;
            }
            let expected = match Expected::from_entry(source) {
                Ok(v) => v,
                Err(_) => continue,
            };
            result.push(RestartCandidate {
                id: source.id.clone(),
                label: source.label.clone(),
                operation_id: expected.operation_id,
                environment_id: expected.environment_id,
                state: source
                    .installation
                    .as_ref()
                    .map_or("unknown", |v| &v.state)
                    .into(),
                completed_steps: source
                    .installation
                    .as_ref()
                    .map_or(0, |v| v.completed_steps),
                total_steps: 12,
            });
        }
        Ok(result)
    }
    fn reserve_restart(
        &self,
        id: &str,
        source_id: &str,
        password: bool,
    ) -> Result<Request, String> {
        environments::validate_id(source_id)?;
        let guard = self.activity(id, ActivityKind::Restart)?;
        let binding = self.restart_binding(id, source_id)?;
        {
            let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            Self::restart_allowed(&inner, &guard.entry)?;
            Self::restart_allowed(
                &inner,
                inner
                    .entries
                    .get(source_id)
                    .ok_or("Original setup missing")?,
            )?;
            inner
                .restart_reviews
                .retain(|v| !same_host(&v.binding.target, &binding.target));
        }
        Ok(Request {
            guard,
            binding,
            reset_id: Uuid::new_v4().to_string(),
            password,
            #[cfg(test)]
            recovery_pending: None,
        })
    }
    fn check_restart_request(&self, request: &Request) -> Result<(), String> {
        self.ready().map_err(|_| SUPERVISOR_UNAVAILABLE)?;
        if request.guard.cancel.load(Ordering::SeqCst) {
            return Err(REQUEST_CANCELLED.into());
        }
        if self
            .restart_binding(&request.binding.id, &request.binding.source_id)
            .map_err(|_| TARGET_UNVERIFIED)?
            != request.binding
        {
            return Err("[restartRequest:targetChanged] Restart target or original operation changed. Review again.".into());
        }
        self.ssh_args(&request.guard.entry)
            .map_err(|_| TRANSPORT_UNAVAILABLE)?;
        let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        if inner
            .activities
            .get(&request.binding.id)
            .is_none_or(|v| v.token != request.guard.token)
        {
            return Err(REQUEST_REPLACED.into());
        }
        Ok(())
    }
    fn restart_input(
        &self,
        request: &Request,
        mode: &str,
        auth: impl FnOnce(
            &Entry,
            &str,
            bool,
            &AtomicBool,
        ) -> Result<Zeroizing<Vec<u8>>, AuthorizationError>,
    ) -> Result<Zeroizing<Vec<u8>>, String> {
        self.check_restart_request(request)?;
        let root = request
            .guard
            .entry
            .inspection
            .as_ref()
            .is_some_and(|v| v.uid == 0);
        let input = auth(
            &request.guard.entry,
            mode,
            request.password && !root,
            &request.guard.cancel,
        )
        .map_err(|error| error.to_string())?;
        self.check_restart_request(request)?;
        Ok(input)
    }
    fn call_restart_helper(
        &self,
        request: &Request,
        mode: &str,
        digest: Option<&str>,
        input: Zeroizing<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        self.call_restart_helper_with_token(request, mode, digest, None, input)
    }
    fn call_restart_helper_with_token(
        &self,
        request: &Request,
        mode: &str,
        digest: Option<&str>,
        recovery_token: Option<&str>,
        input: Zeroizing<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        self.check_restart_request(request)?;
        let valid = match mode {
            "review" | "stop" | "status" | "recover_review" => {
                digest.is_none() && recovery_token.is_none()
            }
            "apply" => digest.is_some_and(digest_valid) && recovery_token.is_none(),
            "recover_apply" => {
                digest.is_some_and(digest_valid) && recovery_token.is_some_and(recovery_token_valid)
            }
            _ => false,
        };
        if !valid {
            return Err("Invalid restart mode or review credentials".into());
        }
        let mut packet =
            json!({"mode":mode,"resetId":request.reset_id,"expected":request.binding.expected});
        if let Some(digest) = digest {
            packet["snapshotDigest"] = json!(digest);
        }
        if let Some(token) = recovery_token {
            packet["recoveryToken"] = json!(token);
        }
        let packet = serde_json::to_vec(&packet).map_err(|_| "Invalid restart packet")?;
        let command = helper_command()?;
        let mut payload = helper_frame(input, HELPER.as_bytes(), &packet)?;
        let root = request
            .guard
            .entry
            .inspection
            .as_ref()
            .is_some_and(|v| v.uid == 0);
        let privilege = if mode == "status" || root {
            ""
        } else if request.password {
            PASSWORD_PRIVILEGE
        } else {
            "sudo -n -- "
        };
        let mut args = self
            .ssh_args(&request.guard.entry)
            .map_err(|_| TRANSPORT_UNAVAILABLE)?;
        args.extend([
            "--".into(),
            request.binding.target.host.clone(),
            format!("{privilege}{command}"),
        ]);
        let bytes = run_bounded(
            self.ssh_program(),
            &args,
            &payload,
            helper_timeout(mode),
            &request.guard.cancel,
            MAX_REPLY,
        );
        payload.fill(0);
        // The generic transport runner cannot distinguish SSH, sudo and helper failures.
        // Never surface its SSH-specific advice as evidence about a local prompt/password.
        bytes.map_err(|_| server_execution_error(mode).into())
    }
    fn restart_review_with(
        &self,
        request: Request,
        auth: impl FnOnce(
            &Entry,
            &str,
            bool,
            &AtomicBool,
        ) -> Result<Zeroizing<Vec<u8>>, AuthorizationError>,
    ) -> Result<RestartReview, String> {
        let input = self.restart_input(&request, "review", auth)?;
        let bytes = self.call_restart_helper(&request, "review", None, input)?;
        self.check_restart_request(&request)?;
        let cached = parse_review(&bytes, &request)
            .map_err(|_| "[serverProtocol:review] The server review response failed identity or scope validation; no cleanup was requested.")?;
        let review = cached.review.clone();
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        inner
            .restart_reviews
            .retain(|v| v.review.expires_at > now());
        if inner.restart_reviews.len() >= 32 {
            inner.restart_reviews.remove(0);
        }
        inner.restart_reviews.push(cached);
        Ok(review)
    }
    fn restart_stop_with(
        &self,
        request: Request,
        auth: impl FnOnce(
            &Entry,
            &str,
            bool,
            &AtomicBool,
        ) -> Result<Zeroizing<Vec<u8>>, AuthorizationError>,
    ) -> Result<(), String> {
        let input = self.restart_input(&request, "stop", auth)?;
        let bytes = self.call_restart_helper(&request, "stop", None, input)?;
        self.check_restart_request(&request)?;
        // Stop has no renderer result; any subsequent removal requires a new root review.
        if !bytes.is_empty() {
            return Err(
                "[serverProtocol:stop] Installation stop is not confirmed. Review again; no cleanup was requested.".into(),
            );
        }
        Ok(())
    }
    fn reserve_restart_apply(
        &self,
        id: &str,
        review_id: &str,
        confirmation: &str,
        password: bool,
    ) -> Result<ApplyRequest, String> {
        let guard = self.activity(id, ActivityKind::Restart)?;
        let mut inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        Self::restart_allowed(&inner, &guard.entry)?;
        let index = inner
            .restart_reviews
            .iter()
            .position(|v| v.binding.id == id && v.review.review_id == review_id)
            .ok_or("Restart review is missing or replaced; review again")?;
        let cached = inner.restart_reviews[index].clone();
        cached.normal()?;
        cached.current()?;
        if confirmation != cached.review.host {
            return Err("Type the exact reviewed hostname to confirm removal".into());
        }
        inner.restart_reviews.remove(index);
        drop(inner);
        let request = Request {
            guard,
            binding: cached.binding.clone(),
            reset_id: cached.review.reset_id.clone(),
            password,
            #[cfg(test)]
            recovery_pending: None,
        };
        self.check_restart_request(&request)?;
        Ok(ApplyRequest { request, cached })
    }
    fn restart_apply_with(
        &self,
        apply: ApplyRequest,
        registry: &environments::Registry,
        auth: impl FnOnce(
            &Entry,
            &str,
            bool,
            &AtomicBool,
        ) -> Result<Zeroizing<Vec<u8>>, AuthorizationError>,
    ) -> Result<RestartResult, String> {
        let ApplyRequest { request, cached } = apply;
        cached.normal()?;
        cached.current()?;
        // Refuse a late original approval as well as unresolved signed work before prompting.
        self.check_restart_request(&request)?;
        {
            let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            Self::restart_allowed(&inner, &request.guard.entry)?;
        }
        let fence = registry.reserve_restart_fence(&request.binding.expected.environment_id)?;
        let affected = {
            let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
            affected_setup_ids(&inner, &request.binding)
        };
        registry.validate_restart_fence(&fence, &affected)?;
        let input = self.restart_input(&request, "apply", auth)?;
        cached.current()?;
        self.check_restart_request(&request)?;
        let pending = self.prepare_restart(&request)?;
        // Both journals are durable before helper dispatch. A failure leaves a recoverable hold.
        registry.commit_restart_fence(&fence, &pending.affected)?;
        self.pause_restart_entries(&pending)?;
        cached.current()?;
        self.check_restart_request(&request)?;
        let outcome = self
            .call_restart_helper(&request, "apply", Some(&cached.snapshot_digest), input)
            .and_then(|bytes| {
                self.check_restart_request(&request)?;
                parse_result(&bytes, &request).map_err(|_| "[serverProtocol:apply] The server cleanup response failed outcome validation. Check restart outcome; do not replay cleanup.".into())
            });
        drop(fence);
        let mut result = self.reconcile_restart(
            &pending.reset_id,
            outcome.as_ref().map_or("unknown", |v| v.state.as_str()),
            outcome
                .as_ref()
                .ok()
                .filter(|v| v.state == "failed")
                .map(|v| v.message.as_str()),
            registry,
        )?;
        if let Err(error) = outcome {
            result.message = format!("{error} {}", result.message);
        }
        Ok(result)
    }
    fn check_restart_absence(&self, guard: &ActivityGuard) -> Result<(), String> {
        self.ready().map_err(|_| SUPERVISOR_UNAVAILABLE)?;
        if guard.cancel.load(Ordering::SeqCst) {
            return Err(REQUEST_CANCELLED.into());
        }
        self.history_list()?;
        let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        if inner
            .activities
            .get(&guard.entry.id)
            .is_none_or(|v| v.token != guard.token)
        {
            return Err(REQUEST_REPLACED.into());
        }
        let entry = inner
            .entries
            .get(&guard.entry.id)
            .ok_or("Unknown setup target")?;
        if entry.id != guard.entry.id
            || entry.target != guard.entry.target
            || entry.fingerprint != guard.entry.fingerprint
        {
            return Err("Restart status target changed; check again".into());
        }
        self.pinned_ssh_args(entry)?;
        // Absence must be confirmed by durable history too, never inferred from a
        // missing/unreadable journal or used to discard an in-memory recovery hold.
        if inner.restart_journal.resolve_status(entry)?.is_some()
            || Journal::read(&self.directory)?
                .resolve_status(entry)?
                .is_some()
        {
            return Err("Restart recovery changed; check restart outcome again".into());
        }
        self.ready().map_err(|_| SUPERVISOR_UNAVAILABLE)?;
        if guard.cancel.load(Ordering::SeqCst) {
            return Err(REQUEST_CANCELLED.into());
        }
        Ok(())
    }
    fn reserve_restart_status(&self, id: &str) -> Result<StatusResolution, String> {
        let guard = self.activity(id, ActivityKind::Restart)?;
        self.pinned_ssh_args(&guard.entry)?;
        let inner = self.inner.lock().map_err(|_| "Setup lock failed")?;
        let Some(pending) = inner.restart_journal.resolve_status(&guard.entry)? else {
            drop(inner);
            self.check_restart_absence(&guard)?;
            return Ok(StatusResolution::None(guard));
        };
        // A different saved, verified working connection can read the same outcome, never reapply.
        let binding = Binding::new(
            &guard.entry,
            inner
                .entries
                .get(&pending.binding.source_id)
                .ok_or("Original setup missing")?,
        )?;
        if binding.expected != pending.binding.expected
            || !same_host(&binding.target, &pending.binding.target)
            || binding.fingerprint != pending.binding.fingerprint
        {
            return Err("Restart reconciliation identity changed".into());
        }
        Ok(StatusResolution::Pending(Request {
            guard,
            binding,
            reset_id: pending.reset_id.clone(),
            password: false,
            #[cfg(test)]
            recovery_pending: None,
        }))
    }
    fn restart_status(
        &self,
        resolution: StatusResolution,
        registry: &environments::Registry,
    ) -> Result<RestartResult, String> {
        let request = match resolution {
            StatusResolution::None(guard) => {
                self.check_restart_absence(&guard)?;
                return Ok(RestartResult {
                    state: "none".into(),
                    reset_id: String::new(),
                    entry: None,
                    message: "No pending restart for this verified setup".into(),
                });
            }
            StatusResolution::Pending(request) => request,
        };
        self.check_restart_request(&request)?;
        let saved = self
            .inner
            .lock()
            .map_err(|_| "Setup lock failed")?
            .restart_journal
            .records
            .get(&request.reset_id)
            .ok_or("Restart missing")?
            .clone();
        if saved.remote_complete {
            return self.reconcile_restart(&saved.reset_id, "complete", None, registry);
        }
        let outcome = self
            .call_restart_helper(&request, "status", None, Zeroizing::new(Vec::new()))
            .and_then(|bytes| {
                self.check_restart_request(&request)?;
                parse_result(&bytes, &request).map_err(|_| "[serverProtocol:status] The server response failed outcome validation. Check restart outcome again.".into())
            });
        let mut result = self.reconcile_restart(
            &saved.reset_id,
            outcome.as_ref().map_or("unknown", |v| v.state.as_str()),
            None,
            registry,
        )?;
        if let Err(error) = outcome {
            result.message = format!("{error} {}", result.message);
        }
        Ok(result)
    }
}

#[tauri::command]
pub fn setup_restart_candidates(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<Vec<RestartCandidate>, String> {
    setup.restart_candidates(&id)
}
#[tauri::command]
pub async fn setup_restart_review(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
    source_id: String,
    password: bool,
) -> Result<RestartReview, String> {
    let setup = setup.inner().clone();
    let request = setup.reserve_restart(&id, &source_id, password)?;
    tauri::async_runtime::spawn_blocking(move || setup.restart_review_with(request, authorize))
        .await
        .map_err(|_| "Restart review interrupted")?
}
#[tauri::command]
pub async fn setup_restart_stop(
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
    source_id: String,
    password: bool,
) -> Result<(), String> {
    let setup = setup.inner().clone();
    let request = setup.reserve_restart(&id, &source_id, password)?;
    tauri::async_runtime::spawn_blocking(move || setup.restart_stop_with(request, authorize))
        .await
        .map_err(|_| "Stop not confirmed; review again")?
}
#[tauri::command]
pub async fn setup_restart_apply(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
    review_id: String,
    confirmation: String,
    password: bool,
) -> Result<RestartResult, String> {
    use tauri::Manager;
    let setup = setup.inner().clone();
    let request = setup.reserve_restart_apply(&id, &review_id, &confirmation, password)?;
    tauri::async_runtime::spawn_blocking(move || {
        setup.restart_apply_with(request, &app.state::<environments::Registry>(), authorize)
    })
    .await
    .map_err(|_| "Restart interrupted; check restart outcome, never replay cleanup")?
}
#[tauri::command]
pub async fn setup_restart_status(
    app: tauri::AppHandle,
    setup: tauri::State<'_, Arc<Setup>>,
    id: String,
) -> Result<RestartResult, String> {
    use tauri::Manager;
    let setup = setup.inner().clone();
    let request = setup.reserve_restart_status(&id)?;
    tauri::async_runtime::spawn_blocking(move || {
        setup.restart_status(request, &app.state::<environments::Registry>())
    })
    .await
    .map_err(|_| "Restart outcome is unknown; check again")?
}
