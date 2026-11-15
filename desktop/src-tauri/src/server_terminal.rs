//! In-memory PTYs; only saved, inspected environment ownership can select an SSH target.
use super::*;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::VecDeque,
    sync::mpsc::{self, Receiver, SyncSender, TryRecvError, TrySendError},
    thread::JoinHandle,
};
use zeroize::Zeroizing;

#[cfg(test)]
#[path = "server_terminal_tests.rs"]
pub(super) mod tests;

const MAX_SESSIONS: usize = 4;
const OUTPUT_CAP: usize = 1024 * 1024;
const READ_CAP: usize = 64 * 1024;
const INPUT_CAP: usize = 16 * 1024;
const QUEUE_CAP: usize = 8;
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_WAKE_INTERVAL: Duration = Duration::from_millis(5);
// Collapse is not disconnect. Unattended sessions are reclaimed only after this lease expires.
const ABANDONED_AFTER: Duration = Duration::from_secs(30 * 60);
const NO_BINDING: &str = "No verified saved SSH binding for this server. Open Server setup, verify its SSH host key and connect the inspected environment before opening a terminal or reboot review.";

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub setup_id: String,
    pub label: String,
    pub host: String,
    pub user: String,
    pub port: u16,
    pub fingerprint: String,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct BoundTarget {
    pub environment_id: String,
    pub target: Target,
    identity_file: Option<String>,
}

pub(super) fn resolve(
    setup: &Setup,
    registry: &environments::Registry,
    environment_id: Option<&str>,
) -> Result<BoundTarget, String> {
    setup.ready()?;
    // Legacy endpoints are not ownership evidence. Neither selected_environment_id nor a
    // sole host in the setup journal proves a legacy connection belongs to that host.
    let environment_id = environment_id.ok_or(NO_BINDING)?;
    environments::validate_id(environment_id)?;
    registry.restart_unfenced(environment_id)?;
    let bindings = registry.ssh_bindings()?;
    let (_, binding) = bindings
        .iter()
        .find(|(id, _)| id == environment_id)
        .ok_or(NO_BINDING)?;
    let inner = setup.inner.lock().map_err(|_| "Setup lock failed")?;
    let entry = inner.entries.get(&binding.setup_id).ok_or(NO_BINDING)?;
    Setup::restart_allowed(&inner, entry)?;
    if entry
        .inspection
        .as_ref()
        .and_then(|i| i.environment.as_ref())
        .is_none_or(|e| e.environment_id != environment_id)
    {
        return Err(NO_BINDING.into());
    }
    setup.ssh_args(entry)?;
    Ok(BoundTarget {
        environment_id: environment_id.into(),
        target: Target {
            setup_id: entry.id.clone(),
            label: entry.label.clone(),
            host: entry.target.host.clone(),
            user: entry.target.user.clone(),
            port: entry.target.port,
            fingerprint: entry.fingerprint.clone(),
        },
        identity_file: entry.target.identity_file.clone(),
    })
}

pub(super) fn revalidate(
    setup: &Setup,
    registry: &environments::Registry,
    bound: &BoundTarget,
) -> Result<(), String> {
    let current = resolve(setup, registry, Some(&bound.environment_id))?;
    // Label changes do not retarget a session. All transport/ownership fields must match.
    if current.environment_id != bound.environment_id
        || current.target.setup_id != bound.target.setup_id
        || current.target.host != bound.target.host
        || current.target.user != bound.target.user
        || current.target.port != bound.target.port
        || current.target.fingerprint != bound.target.fingerprint
        || current.identity_file != bound.identity_file
    {
        return Err(
            "Saved SSH ownership or trust changed. Disconnect and review the server again.".into(),
        );
    }
    Ok(())
}

pub(super) fn ssh_args(
    setup: &Setup,
    bound: &BoundTarget,
    interactive: bool,
) -> Result<Vec<String>, String> {
    let entry = Entry {
        id: bound.target.setup_id.clone(),
        label: bound.target.label.clone(),
        target: super::Target {
            host: bound.target.host.clone(),
            user: bound.target.user.clone(),
            port: bound.target.port,
            identity_file: bound.identity_file.clone(),
        },
        fingerprint: bound.target.fingerprint.clone(),
        phase: String::new(),
        inspection: None,
        recommendation: None,
        endpoint: None,
        error: None,
        log: Vec::new(),
        plan: None,
        installation: None,
        connection_paused: false,
    };
    let mut args = setup.ssh_args(&entry)?;
    if interactive {
        args.retain(|arg| arg != "-T");
        args.push("-tt".into());
    }
    // Disable local SSH escape commands (including ~C and ~!) in the interactive PTY.
    args.extend(
        [
            "-oEscapeChar=none",
            "-oProxyCommand=none",
            "-oProxyJump=none",
            "-oControlPath=none",
            "-oClearAllForwardings=yes",
            "-oHostKeyAlgorithms=ssh-ed25519",
        ]
        .map(String::from),
    );
    args.extend(["--".into(), bound.target.host.clone()]);
    Ok(args)
}

fn dimensions(cols: u32, rows: u32) -> Result<PtySize, String> {
    if !(1..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("Terminal size must be 1–500 columns and 1–300 rows.".into());
    }
    Ok(PtySize {
        cols: cols as u16,
        rows: rows as u16,
        pixel_width: 0,
        pixel_height: 0,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadReply {
    data: String,
    next_offset: u64,
    dropped: bool,
    exited: bool,
    exit_code: Option<u32>,
}

struct Output {
    bytes: VecDeque<u8>,
    end: u64,
    exited: bool,
    exit_code: Option<u32>,
    touched: Instant,
}
impl Default for Output {
    fn default() -> Self {
        Self {
            bytes: VecDeque::new(),
            end: 0,
            exited: false,
            exit_code: None,
            touched: Instant::now(),
        }
    }
}
impl Output {
    fn append(&mut self, data: &[u8]) {
        self.end += data.len() as u64;
        if data.len() >= OUTPUT_CAP {
            self.bytes.clear();
            self.bytes.extend(&data[data.len() - OUTPUT_CAP..]);
        } else {
            let discard = (self.bytes.len() + data.len()).saturating_sub(OUTPUT_CAP);
            self.bytes.drain(..discard);
            self.bytes.extend(data);
        }
    }
    fn read(&mut self, offset: u64) -> Result<ReadReply, String> {
        if offset > self.end {
            return Err("Terminal offset is ahead of available output.".into());
        }
        self.touched = Instant::now();
        let start = self.end - self.bytes.len() as u64;
        let from = offset.max(start);
        let data: Vec<u8> = self
            .bytes
            .iter()
            .skip((from - start) as usize)
            .take(READ_CAP)
            .copied()
            .collect();
        Ok(ReadReply {
            next_offset: from + data.len() as u64,
            data: STANDARD.encode(data),
            dropped: offset < start,
            exited: self.exited,
            exit_code: self.exit_code,
        })
    }
}

enum Input {
    Bytes(Zeroizing<Vec<u8>>),
    Resize(PtySize),
}
struct Session {
    bound: BoundTarget,
    output: Arc<Mutex<Output>>,
    sender: SyncSender<Input>,
    resize: Arc<Mutex<Option<PtySize>>>,
    writes: Arc<tokio::sync::Semaphore>,
    cancel: Arc<AtomicBool>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl Session {
    fn stop(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
    fn send(&self, input: Input) -> Result<(), String> {
        self.send_until(input, Instant::now() + WRITE_TIMEOUT)
    }
    fn send_until(&self, mut input: Input, deadline: Instant) -> Result<(), String> {
        loop {
            if self.cancel.load(Ordering::SeqCst)
                || self
                    .output
                    .lock()
                    .map_err(|_| "Terminal output lock failed")?
                    .exited
            {
                return Err("Terminal exited or disconnected. This input was not queued.".into());
            }
            if let Input::Resize(size) = input {
                // Latest size wins independently of input backpressure. Resizing cannot
                // consume paste capacity or wait behind a remotely blocked stdin write.
                *self
                    .resize
                    .lock()
                    .map_err(|_| "Terminal resize lock failed")? = Some(size);
                self.output
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .touched = Instant::now();
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Terminal input timed out waiting for capacity. This chunk was not queued; do not replay previously accepted chunks.".into());
            }
            match self.sender.try_send(input) {
                Ok(()) => {
                    // After acceptance never return a retryable error for these bytes.
                    self.output
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .touched = Instant::now();
                    return Ok(());
                }
                Err(TrySendError::Full(returned)) => input = returned,
                Err(TrySendError::Disconnected(_)) => {
                    return Err("Terminal exited. This input was not queued.".into())
                }
            }
            // Runs only on a blocking worker, never on the IPC/UI thread. Retrying Full
            // reuses the unaccepted owned chunk; accepted bytes are never submitted twice.
            thread::sleep(
                WRITE_WAKE_INTERVAL.min(deadline.saturating_duration_since(Instant::now())),
            );
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Default)]
struct Sessions {
    closed: bool,
    sessions: BTreeMap<String, Arc<Session>>,
}
#[derive(Default)]
pub struct Terminals {
    inner: Mutex<Sessions>,
}
impl Terminals {
    pub fn close(&self) {
        let sessions = {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            inner.closed = true;
            std::mem::take(&mut inner.sessions)
        };
        for session in sessions.values() {
            session.cancel.store(true, Ordering::SeqCst);
        }
        for session in sessions.values() {
            session.stop();
        }
    }
    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        self.inner
            .lock()
            .map_err(|_| "Terminal session lock failed")?
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| "Terminal session expired or disconnected. Open a new session.".into())
    }
    fn remove(&self, id: &str) -> Result<(), String> {
        let session = self
            .inner
            .lock()
            .map_err(|_| "Terminal session lock failed")?
            .sessions
            .remove(id);
        if let Some(session) = session {
            session.stop();
        }
        Ok(())
    }
    fn open(
        &self,
        bound: BoundTarget,
        command: CommandBuilder,
        size: PtySize,
    ) -> Result<Opened, String> {
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Terminal session lock failed")?;
        if inner.closed {
            return Err("Terminal supervisor is stopping.".into());
        }
        inner.sessions.retain(|_, session| {
            let stale = session
                .output
                .lock()
                .map(|o| o.touched.elapsed() >= ABANDONED_AFTER)
                .unwrap_or(true);
            if stale {
                session.stop();
            }
            !stale
        });
        if inner.sessions.len() >= MAX_SESSIONS {
            return Err("Close an existing terminal before opening another (maximum 4).".into());
        }
        let session_id = Uuid::new_v4().to_string();
        let target = bound.target.clone();
        let session = spawn(bound, command, size)?;
        inner.sessions.insert(session_id.clone(), Arc::new(session));
        Ok(Opened { session_id, target })
    }
}
impl Drop for Terminals {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(unix)]
struct OwnedPty {
    child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
    stream: Option<fs::File>,
}
#[cfg(unix)]
impl OwnedPty {
    fn finish(&mut self) -> Option<u32> {
        let mut child = self.child.take()?;
        if matches!(child.try_wait(), Ok(None)) {
            if let Some(pid) = child.process_id() {
                // SAFETY: this worker exclusively owns this unreaped child.
                unsafe {
                    libc::kill(pid as libc::pid_t, libc::SIGKILL);
                }
            }
        }
        self.stream.take();
        // On macOS the exiting slave can wait for the master to close. Close all master
        // descriptors BEFORE wait(), including on panic or failure to start the worker.
        self.master.take();
        child
            .wait()
            .ok()
            .and_then(|s| s.signal().is_none().then_some(s.exit_code()))
    }
}
#[cfg(unix)]
impl Drop for OwnedPty {
    fn drop(&mut self) {
        self.finish();
    }
}

// One nonblocking worker owns all PTY I/O and the child. IPC never waits for PTY reads
// or writes; closing can always interrupt even when the remote stops reading stdin.
#[cfg(unix)]
fn spawn(bound: BoundTarget, command: CommandBuilder, size: PtySize) -> Result<Session, String> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|_| "Cannot allocate a local terminal PTY")?;
    let fd = pair
        .master
        .as_raw_fd()
        .ok_or("PTY descriptor is unavailable")?;
    // SAFETY: fd is borrowed from the live master, and these calls do not take ownership.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err("Cannot configure nonblocking terminal I/O".into());
        }
    }
    // Do not use portable-pty's writer: its Drop sends newline/EOT, which could submit
    // a partially typed command on disconnect. A plain duplicate closes without input.
    let stream = unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) }
        .try_clone_to_owned()
        .map(fs::File::from)
        .map_err(|_| "Cannot duplicate terminal PTY")?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|_| "Cannot launch system SSH in the terminal PTY")?;
    drop(pair.slave);
    let mut process = OwnedPty {
        child: Some(child),
        master: Some(pair.master),
        stream: Some(stream),
    };
    let output = Arc::new(Mutex::new(Output::default()));
    let cancel = Arc::new(AtomicBool::new(false));
    let (sender, receiver) = mpsc::sync_channel(QUEUE_CAP);
    let resize = Arc::new(Mutex::new(None));
    let worker_resize = resize.clone();
    let worker_output = output.clone();
    let worker_cancel = cancel.clone();
    let worker = thread::Builder::new()
        .name("outpost-ssh-pty".into())
        .spawn(move || {
            let result = pty_loop(
                process.child.as_mut().unwrap().as_mut(),
                process.master.as_ref().unwrap().as_ref(),
                process.stream.as_mut().unwrap(),
                receiver,
                &worker_resize,
                &worker_output,
                &worker_cancel,
            );
            let status = process.finish();
            let mut output = worker_output.lock().unwrap_or_else(|e| e.into_inner());
            output.exited = true;
            output.exit_code = result.or(status);
        })
        .map_err(|_| "Cannot start terminal I/O worker")?;
    Ok(Session {
        bound,
        output,
        sender,
        resize,
        writes: Arc::new(tokio::sync::Semaphore::new(QUEUE_CAP)),
        cancel,
        worker: Mutex::new(Some(worker)),
    })
}
#[cfg(not(unix))]
fn spawn(_: BoundTarget, _: CommandBuilder, _: PtySize) -> Result<Session, String> {
    Err("Native SSH terminals currently require macOS or Linux.".into())
}

fn pty_loop(
    child: &mut dyn portable_pty::Child,
    master: &dyn portable_pty::MasterPty,
    stream: &mut fs::File,
    receiver: Receiver<Input>,
    resize: &Mutex<Option<PtySize>>,
    output: &Mutex<Output>,
    cancel: &AtomicBool,
) -> Option<u32> {
    let mut chunk = Zeroizing::new([0u8; 8192]);
    let mut pending: Option<(Zeroizing<Vec<u8>>, usize)> = None;
    let mut exit = None;
    loop {
        if cancel.load(Ordering::SeqCst)
            || output
                .lock()
                .map(|o| o.touched.elapsed() >= ABANDONED_AFTER)
                .unwrap_or(true)
        {
            break;
        }
        let mut eof = false;
        for _ in 0..8 {
            match stream.read(&mut *chunk) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => output
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .append(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => {
                    eof = true;
                    break;
                }
            }
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                exit = status.signal().is_none().then_some(status.exit_code());
                if eof {
                    break;
                }
            }
            Ok(None) => {
                if eof {
                    break;
                }
            }
            Err(_) => break,
        }
        if let Some(size) = resize.lock().unwrap_or_else(|e| e.into_inner()).take() {
            if master.resize(size).is_err() {
                break;
            }
        }
        if pending.is_none() && exit.is_none() {
            match receiver.try_recv() {
                Ok(Input::Bytes(bytes)) => pending = Some((bytes, 0)),
                Ok(Input::Resize(size)) => {
                    if master.resize(size).is_err() {
                        break;
                    }
                }
                Err(TryRecvError::Disconnected) => break,
                Err(TryRecvError::Empty) => {}
            }
        }
        if let Some((bytes, offset)) = pending.as_mut() {
            match stream.write(&bytes[*offset..]) {
                Ok(0) => break,
                Ok(n) => {
                    *offset += n;
                    if *offset == bytes.len() {
                        pending = None;
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                    ) => {}
                Err(_) => break,
            }
        }
        thread::sleep(Duration::from_millis(10));
    }
    exit
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    session_id: String,
    target: Target,
}

#[tauri::command]
pub fn terminal_target(
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    environment_id: Option<String>,
) -> Result<Target, String> {
    Ok(resolve(&setup, &registry, environment_id.as_deref())?.target)
}
#[tauri::command]
pub async fn terminal_open(
    app: tauri::AppHandle,
    environment_id: Option<String>,
    cols: u32,
    rows: u32,
) -> Result<Opened, String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let setup = app.state::<Arc<Setup>>();
        let registry = app.state::<environments::Registry>();
        let size = dimensions(cols, rows)?;
        let bound = resolve(&setup, &registry, environment_id.as_deref())?;
        let mut command = CommandBuilder::new(setup.ssh_program());
        command.args(ssh_args(&setup, &bound, true)?);
        command.env("TERM", "xterm-256color");
        command.env_remove("SSH_ASKPASS");
        command.env("SSH_ASKPASS_REQUIRE", "never");
        revalidate(&setup, &registry, &bound)?;
        app.state::<Terminals>().open(bound, command, size)
    })
    .await
    .map_err(|_| "Terminal launch interrupted".to_string())?
}
fn checked_session(
    terminals: &Terminals,
    setup: &Setup,
    registry: &environments::Registry,
    id: &str,
) -> Result<Arc<Session>, String> {
    let session = terminals.get(id)?;
    if let Err(error) = revalidate(setup, registry, &session.bound) {
        terminals.remove(id)?;
        return Err(error);
    }
    Ok(session)
}
#[tauri::command]
pub fn terminal_read(
    terminals: tauri::State<'_, Terminals>,
    session_id: String,
    offset: u64,
) -> Result<ReadReply, String> {
    let session = terminals.get(&session_id)?;
    let result = session
        .output
        .lock()
        .map_err(|_| "Terminal output lock failed")?
        .read(offset);
    result
}
fn decode_input(data: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    if data.len() > INPUT_CAP.div_ceil(3) * 4 {
        return Err("Terminal input exceeds 16 KiB.".into());
    }
    let bytes = Zeroizing::new(
        STANDARD
            .decode(data)
            .map_err(|_| "Terminal input must be base64 bytes")?,
    );
    if bytes.len() > INPUT_CAP {
        return Err("Terminal input exceeds 16 KiB.".into());
    }
    Ok(bytes)
}
#[tauri::command]
pub async fn terminal_write(
    app: tauri::AppHandle,
    session_id: String,
    data: String,
) -> Result<(), String> {
    use tauri::Manager;
    let deadline = Instant::now() + WRITE_TIMEOUT;
    let data = Zeroizing::new(data);
    let bytes = decode_input(&data)?;
    let session = app.state::<Terminals>().get(&session_id)?;
    // Bound even concurrently invoked IPC requests before submitting blocking work.
    // Normal serialized UI writes hold one permit and wait for queue capacity below.
    let permit = session.writes.clone().try_acquire_owned().map_err(|_| {
        "Too many concurrent terminal writes. Serialize input requests; this chunk was not queued."
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let session = checked_session(
            &app.state::<Terminals>(),
            &app.state::<Arc<Setup>>(),
            &app.state::<environments::Registry>(),
            &session_id,
        )?;
        if bytes.is_empty() {
            return Ok(());
        }
        session.send_until(Input::Bytes(bytes), deadline)
    })
    .await
    .map_err(|_| {
        "Terminal write was interrupted; delivery is unknown. Do not replay this input.".to_string()
    })?
}
#[tauri::command]
pub fn terminal_resize(
    terminals: tauri::State<'_, Terminals>,
    setup: tauri::State<'_, Arc<Setup>>,
    registry: tauri::State<'_, environments::Registry>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let size = dimensions(cols, rows)?;
    checked_session(&terminals, &setup, &registry, &session_id)?.send(Input::Resize(size))
}
#[tauri::command]
pub async fn terminal_close(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || app.state::<Terminals>().remove(&session_id))
        .await
        .map_err(|_| "Terminal close interrupted".to_string())?
}
