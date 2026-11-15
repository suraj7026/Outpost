//! Local prompt protocol only. Never interpret SSH/sudo failures as local consent outcomes.
use ::zeroize::Zeroizing;
use std::{
    fmt,
    io::{self, Read},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

#[cfg(test)]
#[path = "native_authorization_tests.rs"]
mod tests;

const PREFIX: &str = "OUTPOST-AUTH/1:";
const MAX_PASSWORD: usize = 1024;
const MAX_OUTPUT: usize = MAX_PASSWORD + 128;
const DIALOG_SECONDS: u64 = 170;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Purpose {
    Review,
    RecoveryReview,
    Stop,
    Apply,
}
impl Purpose {
    pub(super) fn from_mode(mode: &str) -> Result<Self, Error> {
        match mode {
            "review" => Ok(Self::Review),
            "recover_review" => Ok(Self::RecoveryReview),
            "stop" => Ok(Self::Stop),
            "apply" => Ok(Self::Apply),
            _ => Err(Error::InvalidResponse),
        }
    }
    fn button(self) -> &'static str {
        match self {
            Self::Review => "Review removal scope",
            Self::RecoveryReview => "Prepare held reset review",
            Self::Stop => "Stop installation",
            Self::Apply => "Remove native installation",
        }
    }
    fn description(self) -> &'static str {
        match self {
            Self::Review => "Read protected original installation evidence and the exact native removal scope. This does not stop, delete, install or repair anything.",
            Self::RecoveryReview => "Check the existing held reset and original installation. Only if deletion never started, write a recovery preparation receipt that blocks stale requests and review the same native removal scope. This does not delete native data or start installation. Removal requires another explicit approval.",
            Self::Stop => "Request cancellation of the selected original Outpost installation only. This is not deletion or uninstall. Review again before removal.",
            Self::Apply => "Permanently remove the reviewed native Outpost installation, including its tasks, credentials, configuration and data. The native server will go offline. Original operation evidence and unrelated services are preserved. This does not authorize a new installation.",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProcessPhase {
    Pipe,
    Spawn,
    Read,
    Wait,
    Exit,
    AppleScript,
}
impl ProcessPhase {
    fn label(self) -> &'static str {
        match self {
            Self::Pipe => "pipe",
            Self::Spawn => "spawn",
            Self::Read => "read",
            Self::Wait => "wait",
            Self::Exit => "exit",
            Self::AppleScript => "appleScript",
        }
    }
}

// These variants contain only provenance we actually observed, never subprocess text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error {
    UserCancel,
    Timeout,
    Unavailable,
    ProcessFailure {
        phase: ProcessPhase,
        code: Option<i32>,
    },
    InvalidResponse,
    RequestCancel,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UserCancel => write!(f, "[localAuthorization:userCancel] The native prompt reported Cancel"),
            Self::Timeout => write!(f, "[localAuthorization:timeout] The native prompt timed out"),
            Self::Unavailable => write!(f, "[localAuthorization:unavailable] The native prompt tool is unavailable"),
            Self::ProcessFailure { phase, code } => {
                write!(f, "[localAuthorization:processFailure:{}] The native prompt failed", phase.label())?;
                if let Some(code) = code {
                    write!(f, " (code {code})")?;
                }
                Ok(())
            }
            Self::InvalidResponse => write!(f, "[localAuthorization:invalidResponse] The native prompt returned an invalid response"),
            Self::RequestCancel => write!(f, "[localAuthorization:requestCancel] The application cancelled the authorization request"),
        }?;
        write!(f, "; no cleanup was dispatched.")
    }
}
impl std::error::Error for Error {}

pub(super) struct Secret(Zeroizing<Vec<u8>>);
impl Secret {
    pub(super) fn into_input(self) -> Zeroizing<Vec<u8>> {
        self.0
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([REDACTED])")
    }
}

fn apple_string(value: &str) -> String {
    format!(
        "\"{}\"",
        value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\r', "\\r")
            .replace('\n', "\\n")
    )
}

pub(super) fn script(purpose: Purpose, target: &str, password: bool) -> String {
    let prompt = apple_string(&format!(
        "{target}. {} {}",
        purpose.description(),
        if password {
            "Enter the server sudo password. It is not saved or sent to the app page."
        } else {
            "Allow this action using the saved SSH account's administrator access?"
        }
    ));
    let button = purpose.button();
    let default = if purpose == Purpose::Review {
        button
    } else {
        "Cancel"
    };
    let field = if password {
        " default answer \"\" with hidden answer"
    } else {
        ""
    };
    let approved = if password {
        format!("\"{PREFIX}approved\" & linefeed & (text returned of dialogReply)")
    } else {
        format!("\"{PREFIX}approved\"")
    };
    // Activate only this script's own application, not System Events/Finder (no automation grant).
    // Focus is best-effort and cannot turn an activation failure into a consent outcome.
    format!(
        r#"try
    tell current application to activate
end try
try
    set dialogReply to (display dialog {prompt}{field} buttons {{"Cancel", "{button}"}} default button "{default}" cancel button "Cancel" with title "Outpost setup restart" giving up after {DIALOG_SECONDS})
    if gave up of dialogReply then return "{PREFIX}timeout"
    if button returned of dialogReply is not "{button}" then return "{PREFIX}invalidResponse"
    return {approved}
on error number errorNumber
    if errorNumber is -128 then return "{PREFIX}userCancel"
    return "{PREFIX}processFailure:" & (errorNumber as text)
end try
"#
    )
}

pub(super) fn prompt(
    purpose: Purpose,
    target: &str,
    password: bool,
    cancelled: &AtomicBool,
) -> Result<Secret, Error> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(Error::RequestCancel);
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("/usr/bin/osascript");
        // The script contains only public purpose/target text. Passwords exist only in the pipe.
        command.args(["-s", "he", "-e", &script(purpose, target, password)]);
        run_prompt_command(&mut command, password, cancelled, PROCESS_TIMEOUT)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (purpose, target, password);
        Err(Error::Unavailable)
    }
}

fn parse_output(bytes: &[u8], password: bool) -> Result<Secret, Error> {
    let frame = bytes.strip_suffix(b"\n").ok_or(Error::InvalidResponse)?;
    let frame = frame
        .strip_prefix(PREFIX.as_bytes())
        .ok_or(Error::InvalidResponse)?;
    match frame {
        b"userCancel" => Err(Error::UserCancel),
        b"timeout" => Err(Error::Timeout),
        b"invalidResponse" => Err(Error::InvalidResponse),
        b"approved" if !password => Ok(Secret(Zeroizing::new(Vec::new()))),
        _ => {
            if let Some(code) = frame.strip_prefix(b"processFailure:") {
                let code = std::str::from_utf8(code)
                    .ok()
                    .and_then(|v| v.parse::<i32>().ok())
                    .filter(|v| v.to_string().as_bytes() == code)
                    .ok_or(Error::InvalidResponse)?;
                return Err(Error::ProcessFailure {
                    phase: ProcessPhase::AppleScript,
                    code: Some(code),
                });
            }
            let value = frame
                .strip_prefix(b"approved\n")
                .filter(|_| password)
                .ok_or(Error::InvalidResponse)?;
            let text = std::str::from_utf8(value).map_err(|_| Error::InvalidResponse)?;
            if value.is_empty() || value.len() > MAX_PASSWORD || text.chars().any(char::is_control)
            {
                return Err(Error::InvalidResponse);
            }
            // Reserve the newline too: no reallocations leave prior password allocations behind.
            let mut input = Zeroizing::new(Vec::with_capacity(value.len() + 1));
            input.extend_from_slice(value);
            input.push(b'\n');
            Ok(Secret(input))
        }
    }
}

pub(super) fn run_prompt_command(
    command: &mut Command,
    password: bool,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<Secret, Error> {
    let bytes = capture(command, cancelled, timeout)?;
    if cancelled.load(Ordering::SeqCst) {
        return Err(Error::RequestCancel);
    }
    parse_output(&bytes, password)
}

struct PromptChild(Child);
impl Drop for PromptChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn process_error(phase: ProcessPhase) -> Error {
    Error::ProcessFailure { phase, code: None }
}

#[cfg(unix)]
fn capture(
    command: &mut Command,
    cancelled: &AtomicBool,
    timeout: Duration,
) -> Result<Zeroizing<Vec<u8>>, Error> {
    use std::os::{fd::OwnedFd, unix::net::UnixStream};
    if cancelled.load(Ordering::SeqCst) {
        return Err(Error::RequestCancel);
    }
    let start = Instant::now();
    let (mut reader, writer) = UnixStream::pair().map_err(|_| process_error(ProcessPhase::Pipe))?;
    reader
        .set_nonblocking(true)
        .map_err(|_| process_error(ProcessPhase::Pipe))?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(writer)))
        .stderr(Stdio::null());
    let spawned = command.spawn();
    // Command retains explicitly supplied descriptors after spawn. Close its writer too, or
    // EOF can never arrive, even after a successful affirmative response and process exit.
    command.stdout(Stdio::null());
    let mut child = PromptChild(spawned.map_err(|e| {
        if e.kind() == io::ErrorKind::NotFound {
            Error::Unavailable
        } else {
            process_error(ProcessPhase::Spawn)
        }
    })?);
    let mut output = Zeroizing::new(Vec::with_capacity(MAX_OUTPUT));
    let mut chunk = Zeroizing::new([0u8; 256]);
    let mut eof = false;
    let mut exited = false;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return Err(Error::RequestCancel);
        }
        if start.elapsed() >= timeout {
            return Err(Error::Timeout);
        }
        if !eof {
            match reader.read(&mut *chunk) {
                Ok(0) => eof = true,
                Ok(count) => {
                    if output.len() + count > MAX_OUTPUT {
                        return Err(Error::InvalidResponse);
                    }
                    output.extend_from_slice(&chunk[..count]);
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => return Err(process_error(ProcessPhase::Read)),
            }
        }
        if !exited {
            if let Some(status) = child
                .0
                .try_wait()
                .map_err(|_| process_error(ProcessPhase::Wait))?
            {
                if !status.success() {
                    return Err(Error::ProcessFailure {
                        phase: ProcessPhase::Exit,
                        code: status.code(),
                    });
                }
                exited = true;
            }
        }
        if exited && eof {
            if cancelled.load(Ordering::SeqCst) {
                return Err(Error::RequestCancel);
            }
            return Ok(output);
        }
        thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(not(unix))]
fn capture(_: &mut Command, _: &AtomicBool, _: Duration) -> Result<Zeroizing<Vec<u8>>, Error> {
    Err(Error::Unavailable)
}
