//! OS reboot is not installation reset. Reviews are volatile, exact-target and single-use.
use super::*;
use terminal::{BoundTarget, Target};
use zeroize::Zeroizing;

// Reuse the protected native prompt capture/parser, not the installation-reset wording.
#[allow(dead_code)]
#[path = "native_authorization.rs"]
mod authorization;
#[path = "server_reboot_state.rs"]
mod state;
#[cfg(test)]
#[path = "server_reboot_tests.rs"]
mod tests;

const REVIEW_TTL: Duration = Duration::from_secs(300);
const STATUS_WINDOW: Duration = Duration::from_secs(180);
const STATUS_INTERVAL: Duration = Duration::from_secs(5);
const SSH_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_REVIEWS: usize = 16;
const BOOT_ID: &str = "/bin/cat /proc/sys/kernel/random/boot_id";
const REBOOT: &str =
    "/usr/bin/sudo -n -- /usr/bin/systemctl reboot && printf 'OUTPOST-REBOOT-REQUESTED\\n'";
const REBOOT_PASSWORD: &str =
    "/usr/bin/sudo -k -S -p '' -- /usr/bin/systemctl reboot && printf 'OUTPOST-REBOOT-REQUESTED\\n'";
const ACK: &[u8] = b"OUTPOST-REBOOT-REQUESTED\n";
const GUARD_OK: &[u8] = b"OUTPOST-REBOOT-GUARD-OK\n";
const GUARD_REJECTED: &[u8] = b"OUTPOST-REBOOT-STALE\n";

#[derive(Clone)]
struct Review {
    bound: BoundTarget,
    boot_id: String,
    created: Instant,
    consumed: bool,
    dispatched: Option<Instant>,
    checking: bool,
    last_check: Option<Instant>,
    returned: bool,
    generation: u64,
    guard_passed: Option<bool>,
}
impl Review {
    fn consume(&mut self, confirmation: &str) -> Result<(), String> {
        if self.consumed {
            return Err("This reboot review has already been used. Review again; no automatic retry is allowed.".into());
        }
        if self.created.elapsed() >= REVIEW_TTL {
            return Err("Reboot review expired. Review this server again.".into());
        }
        if confirmation != self.bound.target.host {
            return Err("Type the exact reviewed host to confirm this OS reboot.".into());
        }
        self.consumed = true;
        Ok(())
    }
}
#[derive(Default)]
pub struct Reboots {
    reviews: Mutex<BTreeMap<String, Review>>,
    cancelled: AtomicBool,
    control: Mutex<state::Control>,
    drained: std::sync::Condvar,
}
impl Reboots {
    fn review(
        &self,
        setup: &Setup,
        registry: &environments::Registry,
        environment_id: Option<&str>,
    ) -> Result<Reviewed, String> {
        let _slot = self.slot()?;
        let bound = terminal::resolve(setup, registry, environment_id)?;
        let generation = self.review_generation(&bound.target)?;
        let boot_id = inspect_boot(setup, &bound, &self.cancelled)?;
        terminal::revalidate(setup, registry, &bound)?;
        if self.review_generation(&bound.target)? != generation {
            return Err(
                "The host reboot generation changed during inspection. Create a fresh review."
                    .into(),
            );
        }
        let mut reviews = self
            .reviews
            .lock()
            .map_err(|_| "Reboot review lock failed")?;
        reviews.retain(|_, review| match review.dispatched {
            Some(at) => at.elapsed() < STATUS_WINDOW + Duration::from_secs(60),
            None => review.created.elapsed() < REVIEW_TTL,
        });
        if reviews.len() >= MAX_REVIEWS {
            return Err("Too many pending reboot reviews. Wait for them to expire.".into());
        }
        let review_id = Uuid::new_v4().to_string();
        let target = bound.target.clone();
        reviews.insert(
            review_id.clone(),
            Review {
                bound,
                boot_id,
                created: Instant::now(),
                consumed: false,
                dispatched: None,
                checking: false,
                last_check: None,
                returned: false,
                generation,
                guard_passed: None,
            },
        );
        Ok(Reviewed { review_id, target })
    }

    fn apply(
        &self,
        setup: &Setup,
        registry: &environments::Registry,
        id: &str,
        confirmation: &str,
        password: bool,
    ) -> Result<ApplyReply, String> {
        self.apply_with(
            setup,
            registry,
            id,
            confirmation,
            password,
            prompt_password,
            execute,
        )
    }
    fn apply_with(
        &self,
        setup: &Setup,
        registry: &environments::Registry,
        id: &str,
        confirmation: &str,
        password: bool,
        prompt: impl FnOnce(&Target, &AtomicBool) -> Result<Zeroizing<Vec<u8>>, String>,
        dispatch: impl FnOnce(&Setup, &BoundTarget, &str, &[u8], &AtomicBool) -> Result<Vec<u8>, String>,
    ) -> Result<ApplyReply, String> {
        let _slot = self.slot()?;
        // Consumption precedes both the native dialog and dispatch; cancellation cannot reuse it.
        let (review, reservation) = self.consume(id, confirmation)?;
        terminal::revalidate(setup, registry, &review.bound)?;
        let secret = if password {
            prompt(&review.bound.target, &self.cancelled)?
        } else {
            Zeroizing::new(Vec::new())
        };
        terminal::revalidate(setup, registry, &review.bound)?;
        if self.cancelled.load(Ordering::SeqCst) {
            return Err("Reboot cancelled before dispatch.".into());
        }
        if review.created.elapsed() >= REVIEW_TTL {
            return Err("Reboot review expired during authorization. Review again; no reboot was dispatched.".into());
        }
        // Authorization can take minutes. An external reboot invalidates the reviewed boot,
        // even if the SSH pin and environment binding are unchanged.
        if inspect_boot(setup, &review.bound, &self.cancelled)? != review.boot_id {
            return Err("The server boot ID changed after review. No reboot was dispatched; review the current boot again.".into());
        }
        terminal::revalidate(setup, registry, &review.bound)?;
        let remote = reboot_command(&review.boot_id, password)?;
        reservation.dispatch()?;
        let result = dispatch(setup, &review.bound, &remote, &secret, &self.cancelled);
        if result.as_ref().is_ok_and(|bytes| bytes == GUARD_REJECTED) {
            reservation.guard_rejected()?;
            return Ok(ApplyReply { state: "unknown", message: "The remote boot guard rejected a changed or unreadable boot ID. No reboot was requested. This review is consumed; inspect the current boot before a new review.".into() });
        }
        let guard_passed = result
            .as_ref()
            .is_ok_and(|bytes| bytes.starts_with(GUARD_OK));
        self.reviews
            .lock()
            .map_err(|_| "Reboot review lock failed")?
            .get_mut(id)
            .ok_or("Reboot review expired")?
            .guard_passed = Some(guard_passed);
        Ok(match result {
            Ok(bytes) if bytes.strip_prefix(GUARD_OK) == Some(ACK) => ApplyReply { state: "requested", message: "The server acknowledged the guarded OS reboot request. Waiting for a changed boot ID; completion is not yet verified.".into() },
            _ => ApplyReply { state: "unknown", message: "The guarded SSH command did not acknowledge the reboot. It may have been dispatched before the connection closed. Do not retry; this server remains reserved pending verification.".into() },
        })
    }
    fn status(
        &self,
        setup: &Setup,
        registry: &environments::Registry,
        id: &str,
    ) -> Result<StatusReply, String> {
        let _slot = self.slot()?;
        let review = {
            let mut reviews = self
                .reviews
                .lock()
                .map_err(|_| "Reboot review lock failed")?;
            let Some(review) = reviews.get_mut(id) else {
                return Ok(unknown(
                    "Reboot review expired. Check the server console; no reboot was resent.",
                ));
            };
            if terminal::revalidate(setup, registry, &review.bound).is_err() {
                return Ok(unknown("Saved SSH ownership or trust changed; verification stopped. No reboot was resent."));
            }
            if review.returned {
                return Ok(returned());
            }
            let Some(dispatched) = review.dispatched else {
                return Ok(unknown("No reboot command was dispatched for this review."));
            };
            if dispatched.elapsed() >= STATUS_WINDOW {
                return Ok(unknown("The three-minute verification window ended without a changed boot ID. Check the server console; no reboot was resent."));
            }
            if review.guard_passed == Some(false) {
                return Ok(unknown("The remote pre-dispatch boot guard was not acknowledged. A different boot cannot be attributed to this request; no reboot is resent."));
            }
            if review.guard_passed.is_none() {
                return Ok(waiting());
            }
            if review.checking
                || review
                    .last_check
                    .is_some_and(|at| at.elapsed() < STATUS_INTERVAL)
            {
                return Ok(waiting());
            }
            review.checking = true;
            review.last_check = Some(Instant::now());
            review.clone()
        };
        let result = terminal::revalidate(setup, registry, &review.bound)
            .and_then(|_| inspect_boot(setup, &review.bound, &self.cancelled))
            .and_then(|boot| {
                terminal::revalidate(setup, registry, &review.bound)?;
                Ok(boot)
            });
        {
            let mut reviews = self
                .reviews
                .lock()
                .map_err(|_| "Reboot review lock failed")?;
            let Some(current) = reviews.get_mut(id) else {
                return Ok(unknown("Reboot review expired. No reboot was resent."));
            };
            current.checking = false;
        }
        if result.as_ref().is_ok_and(|boot| boot != &review.boot_id) {
            self.verified_return(id, &review)?;
            return Ok(returned());
        }
        if terminal::revalidate(setup, registry, &review.bound).is_err() {
            return Ok(unknown("Saved SSH ownership or trust changed; verification stopped. Review the server connection before continuing."));
        }
        Ok(waiting())
    }
}
impl Drop for Reboots {
    fn drop(&mut self) {
        self.close();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewed {
    review_id: String,
    target: Target,
}
#[derive(Debug, Serialize)]
pub struct ApplyReply {
    state: &'static str,
    message: String,
}
#[derive(Serialize)]
pub struct StatusReply {
    state: &'static str,
    message: String,
}
fn unknown(message: &str) -> StatusReply {
    StatusReply {
        state: "unknown",
        message: message.into(),
    }
}
fn waiting() -> StatusReply {
    StatusReply { state: "waiting", message: "Waiting for pinned SSH access and a boot ID different from the reviewed boot. No reboot command is resent.".into() }
}
fn returned() -> StatusReply {
    StatusReply {
        state: "returned",
        message: "The same pinned SSH server returned with a changed boot ID. OS reboot verified."
            .into(),
    }
}

fn parse_boot(bytes: &[u8]) -> Result<String, String> {
    let value = std::str::from_utf8(bytes)
        .map_err(|_| "Server boot ID is not valid UTF-8")?
        .trim_end_matches('\n');
    let id = Uuid::parse_str(value)
        .map_err(|_| "Server did not return a Linux boot ID. Reboot review is unavailable.")?;
    if value != id.to_string() || id.is_nil() {
        return Err("Server returned a malformed Linux boot ID.".into());
    }
    Ok(value.into())
}
fn inspect_boot(
    setup: &Setup,
    bound: &BoundTarget,
    cancelled: &AtomicBool,
) -> Result<String, String> {
    parse_boot(&execute(setup, bound, BOOT_ID, &[], cancelled)?)
}
const GUARD_PREFIX: &str =
    "if IFS= read -r outpost_boot < /proc/sys/kernel/random/boot_id && [ \"$outpost_boot\" = '";
fn reboot_command(expected: &str, password: bool) -> Result<String, String> {
    if parse_boot(expected.as_bytes())? != expected {
        return Err("Invalid expected boot ID".into());
    }
    let action = if password { REBOOT_PASSWORD } else { REBOOT };
    Ok(format!("{GUARD_PREFIX}{expected}' ]; then printf 'OUTPOST-REBOOT-GUARD-OK\\n'; {action}; else printf 'OUTPOST-REBOOT-STALE\\n'; fi"))
}
fn allowed_remote(remote: &str) -> bool {
    if remote == BOOT_ID {
        return true;
    }
    let Some(expected) = remote
        .strip_prefix(GUARD_PREFIX)
        .and_then(|rest| rest.get(..36))
    else {
        return false;
    };
    [false, true]
        .into_iter()
        .any(|password| reboot_command(expected, password).is_ok_and(|command| command == remote))
}
fn execute(
    setup: &Setup,
    bound: &BoundTarget,
    remote: &str,
    input: &[u8],
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    if !allowed_remote(remote) {
        return Err("Unsupported fixed server command".into());
    }
    let mut args = terminal::ssh_args(setup, bound, false)?;
    args.push(remote.into());
    let mut command = Command::new(setup.ssh_program());
    command
        .args(args)
        .env_remove("SSH_ASKPASS")
        .env("SSH_ASKPASS_REQUIRE", "never");
    capture_inner(
        &mut command,
        input,
        cancelled,
        SSH_TIMEOUT,
        remote != BOOT_ID,
    )
}

// No remote stdout/stderr is surfaced or logged, especially on sudo/authentication failure.
// Nonblocking socket capture and a bounded stdin write avoid unbounded reader/writer joins.
#[cfg(all(unix, test))]
fn capture(
    command: &mut Command,
    input: &[u8],
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    capture_inner(command, input, cancelled, timeout, false)
}
#[cfg(unix)]
fn capture_inner(
    command: &mut Command,
    input: &[u8],
    cancelled: &AtomicBool,
    timeout: Duration,
    preserve_partial: bool,
) -> Result<Vec<u8>, String> {
    use std::os::{fd::OwnedFd, unix::net::UnixStream};
    if cancelled.load(Ordering::SeqCst) {
        return Err("Server command cancelled before dispatch.".into());
    }
    if input.len() > 1025 {
        return Err("Protected authorization input exceeds its limit.".into());
    }
    let (mut reader, writer) =
        UnixStream::pair().map_err(|_| "Cannot create protected SSH output pipe")?;
    reader
        .set_nonblocking(true)
        .map_err(|_| "Cannot configure SSH output pipe")?;
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::null());
    let spawned = command.spawn();
    command.stdout(Stdio::null());
    let mut child = OwnedChild(spawned.map_err(|_| "Cannot launch system SSH")?);
    // <= PIPE_BUF, written once to a fresh pipe, without ever placing the password in argv.
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(input)
            .map_err(|_| "Protected SSH input closed")?;
    }
    let started = Instant::now();
    let mut bytes = Zeroizing::new(Vec::with_capacity(512));
    let mut chunk = Zeroizing::new([0u8; 256]);
    let mut eof = false;
    let mut status = None;
    loop {
        if cancelled.load(Ordering::SeqCst) || started.elapsed() >= timeout {
            if preserve_partial {
                return Ok(std::mem::take(&mut *bytes));
            }
            return Err("Server command interrupted or timed out.".into());
        }
        if !eof {
            match reader.read(&mut *chunk) {
                Ok(0) => eof = true,
                Ok(n) => {
                    if bytes.len() + n > 512 {
                        return Err("Server command response exceeded its limit.".into());
                    }
                    bytes.extend_from_slice(&chunk[..n]);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                    ) => {}
                Err(_) => return Err("Server command output interrupted.".into()),
            }
        }
        if status.is_none() {
            status = child.try_wait().map_err(|_| "Cannot wait for system SSH")?;
        }
        if eof {
            if let Some(status) = status {
                if !status.success() && !preserve_partial {
                    return Err("Server command was not acknowledged. Check pinned SSH access and sudo authorization.".into());
                }
                return Ok(std::mem::take(&mut *bytes));
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
}
#[cfg(not(unix))]
fn capture_inner(
    _: &mut Command,
    _: &[u8],
    _: &AtomicBool,
    _: Duration,
    _: bool,
) -> Result<Vec<u8>, String> {
    Err("OS reboot currently requires macOS or Linux.".into())
}

fn prompt_script(target: &Target) -> String {
    // These fields are validated SSH tokens, never arbitrary UI text or saved labels.
    let host = format!("{}@{}:{}", target.user, target.host, target.port);
    format!(
        r#"try
    tell current application to activate
end try
try
    set dialogReply to (display dialog "Reboot the operating system on {host}. All services on this host will be interrupted. This does not reset or remove the Outpost installation. Enter the server sudo password; it is not saved or sent to the app page." default answer "" with hidden answer buttons {{"Cancel", "Reboot server"}} default button "Cancel" cancel button "Cancel" with title "Outpost server reboot" giving up after 170)
    if gave up of dialogReply then return "OUTPOST-AUTH/1:timeout"
    if button returned of dialogReply is not "Reboot server" then return "OUTPOST-AUTH/1:invalidResponse"
    return "OUTPOST-AUTH/1:approved" & linefeed & (text returned of dialogReply)
on error number errorNumber
    if errorNumber is -128 then return "OUTPOST-AUTH/1:userCancel"
    return "OUTPOST-AUTH/1:processFailure:" & (errorNumber as text)
end try
"#
    )
}
fn prompt_password(target: &Target, cancelled: &AtomicBool) -> Result<Zeroizing<Vec<u8>>, String> {
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/osascript");
        command.args(["-s", "he", "-e", &prompt_script(target)]);
        authorization::run_prompt_command(&mut command, true, cancelled, Duration::from_secs(180))
            .map(|secret| secret.into_input())
            .map_err(|error| format!("{error} No OS reboot was dispatched."))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (target, cancelled);
        Err("Protected sudo password entry is unavailable on this platform. No OS reboot was dispatched; configure noninteractive sudo or use the terminal.".into())
    }
}

#[tauri::command]
pub async fn server_reboot_review(
    app: tauri::AppHandle,
    environment_id: Option<String>,
) -> Result<Reviewed, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Reboots>().review(
            &app.state::<Arc<Setup>>(),
            &app.state::<environments::Registry>(),
            environment_id.as_deref(),
        )
    })
    .await
    .map_err(|_| "Reboot review interrupted".to_string())?
}
#[tauri::command]
pub async fn server_reboot_apply(
    app: tauri::AppHandle,
    review_id: String,
    confirmation: String,
    password: bool,
) -> Result<ApplyReply, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Reboots>().apply(
            &app.state::<Arc<Setup>>(),
            &app.state::<environments::Registry>(),
            &review_id,
            &confirmation,
            password,
        )
    })
    .await
    .map_err(|_| {
        "Reboot outcome is unknown. Check status; never retry automatically.".to_string()
    })?
}
#[tauri::command]
pub async fn server_reboot_status(
    app: tauri::AppHandle,
    review_id: String,
) -> Result<StatusReply, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Reboots>().status(
            &app.state::<Arc<Setup>>(),
            &app.state::<environments::Registry>(),
            &review_id,
        )
    })
    .await
    .map_err(|_| "Reboot status check interrupted".to_string())?
}
