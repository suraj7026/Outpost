use reqwest::Url;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const LIMIT: usize = 40 * 1024;
const INVALID: &str = "Unsupported browser sign-in callback";
const CLOSED: &str = "Browser sign-in closed or expired; start a fresh sign-in";

struct Callback {
    redirect: Url,
    state: String,
}
impl Callback {
    fn from_authorization(value: &str) -> Result<Self, &'static str> {
        let url = Url::parse(value).map_err(|_| INVALID)?;
        if value.len() > 16384
            || url.scheme() != "https"
            || url.host_str() != Some("auth.openai.com")
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || !matches!(url.path(), "/api/accounts/authorize" | "/oauth/authorize")
        {
            return Err(INVALID);
        }
        let unique = |name: &str| -> Result<String, &'static str> {
            let values: Vec<_> = url
                .query_pairs()
                .filter(|(key, _)| key == name)
                .map(|(_, v)| v.into_owned())
                .collect();
            if values.len() != 1 {
                return Err(INVALID);
            }
            Ok(values[0].clone())
        };
        let state = unique("state")?;
        let redirect = Url::parse(&unique("redirect_uri")?).map_err(|_| INVALID)?;
        if !(16..=512).contains(&state.len())
            || redirect.scheme() != "http"
            || !matches!(redirect.host_str(), Some("127.0.0.1" | "localhost"))
            || redirect.port() != Some(1455)
            || redirect.path() != "/auth/callback"
            || redirect.query().is_some()
            || redirect.fragment().is_some()
            || !redirect.username().is_empty()
            || redirect.password().is_some()
        {
            return Err(INVALID);
        }
        Ok(Self { redirect, state })
    }
    fn receive(&self, request: &str) -> Option<String> {
        let mut lines = request.split("\r\n");
        let first: Vec<_> = lines.next()?.split_whitespace().collect();
        if first.len() != 3
            || first[0] != "GET"
            || !first[1].starts_with('/')
            || first[1].starts_with("//")
            || !matches!(first[2], "HTTP/1.1" | "HTTP/1.0")
        {
            return None;
        }
        let mut hosts = Vec::new();
        for line in lines.take_while(|line| !line.is_empty()) {
            let (key, value) = line.split_once(':')?;
            if key.eq_ignore_ascii_case("host") {
                hosts.push(value.trim());
            }
            if key.eq_ignore_ascii_case("origin") || key.eq_ignore_ascii_case("transfer-encoding") {
                return None;
            }
            if key.eq_ignore_ascii_case("content-length") && value.trim() != "0" {
                return None;
            }
        }
        let authority = format!("{}:1455", self.redirect.host_str()?);
        if hosts != [authority.as_str()] {
            return None;
        }
        let url = Url::parse(&format!(
            "{}{}",
            self.redirect.origin().ascii_serialization(),
            first[1]
        ))
        .ok()?;
        if url.path() != self.redirect.path()
            || url.fragment().is_some()
            || url.as_str().len() > 32768
        {
            return None;
        }
        let values = |name: &str| {
            url.query_pairs()
                .filter(|(key, _)| key == name)
                .map(|(_, v)| v.into_owned())
                .collect::<Vec<_>>()
        };
        let state = values("state");
        let code = values("code");
        if state.len() != 1
            || state[0] != self.state
            || code.len() != 1
            || code[0].is_empty()
            || !values("error").is_empty()
        {
            return None;
        }
        Some(url.into())
    }
}

struct Session {
    id: String,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
    receiver: Option<mpsc::Receiver<String>>,
}
#[derive(Default)]
pub struct State(Mutex<Option<Session>>);

fn serve(
    mut stream: TcpStream,
    callback: &Callback,
    cancelled: &AtomicBool,
    deadline: Instant,
) -> Option<String> {
    stream
        .set_read_timeout(Some(Duration::from_millis(200)))
        .ok()?;
    stream
        .set_write_timeout(Some(Duration::from_millis(200)))
        .ok()?;
    let reading_until = Instant::now() + Duration::from_secs(2);
    let mut bytes = Vec::new();
    let mut chunk = [0; 2048];
    loop {
        if cancelled.load(Ordering::SeqCst)
            || Instant::now() >= deadline
            || Instant::now() >= reading_until
        {
            return None;
        }
        match stream.read(&mut chunk) {
            Ok(0) => return None,
            Ok(n) => {
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > LIMIT {
                    return None;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                continue
            }
            Err(_) => return None,
        }
        if bytes.windows(4).any(|part| part == b"\r\n\r\n") {
            break;
        }
    }
    let result = std::str::from_utf8(&bytes)
        .ok()
        .and_then(|request| callback.receive(request));
    if cancelled.load(Ordering::SeqCst) || Instant::now() >= deadline {
        return None;
    }
    let (status, message) = if result.is_some() {
        ("200 OK", "Sign-in response received. Return to Outpost to finish and save the server credential. You can close this tab.")
    } else {
        ("400 Bad Request", "This callback does not match the active Outpost sign-in. Return to Outpost and try again.")
    };
    let body = format!("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Outpost sign-in</title><h1>Outpost sign-in</h1><p>{message}</p></html>");
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n{body}", body.len());
    result
}
fn listen(
    listener: TcpListener,
    callback: Callback,
    cancelled: Arc<AtomicBool>,
    deadline: Instant,
) -> Result<mpsc::Receiver<String>, &'static str> {
    listener.set_nonblocking(true).map_err(|_| INVALID)?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        while !cancelled.load(Ordering::SeqCst) && Instant::now() < deadline {
            match listener.accept() {
                Ok((stream, peer)) if peer.ip().is_loopback() => {
                    if let Some(value) = serve(stream, &callback, &cancelled, deadline) {
                        if !cancelled.load(Ordering::SeqCst) {
                            let _ = sender.send(value);
                        }
                        break;
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(25))
                }
                Err(_) => break,
            }
        }
    });
    Ok(receiver)
}
impl State {
    fn start(&self, id: String, authorization_url: String, expires_at: u64) -> Result<(), String> {
        Uuid::parse_str(&id).map_err(|_| INVALID)?;
        let callback = Callback::from_authorization(&authorization_url)?;
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| CLOSED)?
            .as_millis() as u64;
        if expires_at <= now || expires_at - now > 600000 {
            return Err(CLOSED.into());
        }
        let mut current = self.0.lock().map_err(|_| CLOSED)?;
        if let Some(previous) = current.as_ref() {
            if previous.deadline > Instant::now() && !previous.cancelled.load(Ordering::SeqCst) {
                return Err("Another browser sign-in is already open in Outpost".into());
            }
            previous.cancelled.store(true, Ordering::SeqCst);
        }
        let listener = TcpListener::bind(("127.0.0.1", 1455)).map_err(|_| {
            "Port 1455 is already in use. Close the other login or use manual sign-in."
        })?;
        let cancelled = Arc::new(AtomicBool::new(false));
        let deadline = Instant::now() + Duration::from_millis(expires_at - now);
        let receiver = listen(listener, callback, cancelled.clone(), deadline)?;
        *current = Some(Session {
            id,
            cancelled,
            deadline,
            receiver: Some(receiver),
        });
        Ok(())
    }
    fn cancel(&self, id: &str) {
        if let Ok(mut current) = self.0.lock() {
            if current.as_ref().is_some_and(|session| session.id == id) {
                if let Some(session) = current.take() {
                    session.cancelled.store(true, Ordering::SeqCst);
                }
            }
        }
    }
    fn take(&self, id: &str) -> Result<(mpsc::Receiver<String>, Arc<AtomicBool>, Instant), String> {
        let mut current = self.0.lock().map_err(|_| CLOSED)?;
        let session = current
            .as_mut()
            .filter(|session| session.id == id)
            .ok_or(CLOSED)?;
        if session.deadline <= Instant::now() || session.cancelled.load(Ordering::SeqCst) {
            return Err(CLOSED.into());
        }
        Ok((
            session.receiver.take().ok_or(CLOSED)?,
            session.cancelled.clone(),
            session.deadline,
        ))
    }
}
#[tauri::command]
pub fn oauth_callback_start(
    state: tauri::State<'_, State>,
    id: String,
    authorization_url: String,
    expires_at: u64,
) -> Result<(), String> {
    state.start(id, authorization_url, expires_at)
}
#[tauri::command]
pub fn oauth_callback_cancel(state: tauri::State<'_, State>, id: String) {
    state.cancel(&id);
}
#[tauri::command]
pub async fn oauth_callback_wait(
    state: tauri::State<'_, State>,
    id: String,
) -> Result<String, String> {
    let (receiver, cancelled, deadline) = state.take(&id)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        while Instant::now() < deadline && !cancelled.load(Ordering::SeqCst) {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(value) if !cancelled.load(Ordering::SeqCst) && Instant::now() < deadline => {
                    return Ok(value)
                }
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                _ => break,
            }
        }
        Err(CLOSED.to_string())
    })
    .await
    .map_err(|_| CLOSED.to_string())?;
    state.cancel(&id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn authorization() -> String {
        let mut url = Url::parse("https://auth.openai.com/api/accounts/authorize").unwrap();
        url.query_pairs_mut()
            .append_pair("redirect_uri", "http://127.0.0.1:1455/auth/callback")
            .append_pair("state", "synthetic-state-123456789");
        url.into()
    }
    #[test]
    fn only_expected_openai_loopback_callback_is_accepted() {
        let callback = Callback::from_authorization(&authorization()).unwrap();
        let request = "GET /auth/callback?code=synthetic-code&state=synthetic-state-123456789&client_id=issued-client HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n";
        assert!(callback
            .receive(request)
            .unwrap()
            .contains("client_id=issued-client"));
        for invalid in [
            request.replace("synthetic-state-123456789", "wrong-state"),
            request.replace("GET ", "POST "),
            request.replace("/auth/callback?", "/other?"),
            request.replace("Host: 127.0.0.1:1455", "Host: attacker.test"),
            request.replace("&client_id", "&state=second&client_id"),
            request.replace("Host:", "Origin: https://attacker.test\r\nHost:"),
        ] {
            assert!(callback.receive(&invalid).is_none());
        }
        for invalid in [
            authorization().replace("auth.openai.com", "attacker.test"),
            authorization().replace("1455", "4318"),
            authorization().replace("127.0.0.1", "192.168.1.1"),
            authorization() + "&state=duplicate",
            authorization().replace("https://", "http://"),
        ] {
            assert!(Callback::from_authorization(&invalid).is_err());
        }
    }
    #[test]
    fn real_loopback_capture_is_single_use_and_never_echoes_code() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let receiver = listen(
            listener,
            Callback::from_authorization(&authorization()).unwrap(),
            cancelled,
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
        let mut stream = TcpStream::connect(address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        write!(stream, "GET /auth/callback?code=synthetic-private-code&state=synthetic-state-123456789&client_id=issued-client HTTP/1.1\r\nHost: 127.0.0.1:1455\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(!response.contains("synthetic-private-code"));
        let captured = receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(captured.contains("client_id=issued-client"));
        assert!(receiver.recv_timeout(Duration::from_secs(1)).is_err());
    }
    #[test]
    fn wait_and_cancel_are_bound_to_the_native_session() {
        let state = State::default();
        let cancelled = Arc::new(AtomicBool::new(false));
        let (_sender, receiver) = mpsc::channel();
        *state.0.lock().unwrap() = Some(Session {
            id: "active".into(),
            cancelled: cancelled.clone(),
            deadline: Instant::now() + Duration::from_secs(5),
            receiver: Some(receiver),
        });
        assert!(state.take("stale").is_err());
        state.cancel("stale");
        assert!(!cancelled.load(Ordering::SeqCst));
        assert!(state.take("active").is_ok());
        assert!(
            state.take("active").is_err(),
            "Only one waiter can receive the private URL"
        );
        state.cancel("active");
        assert!(cancelled.load(Ordering::SeqCst));
        assert!(state.0.lock().unwrap().is_none());
        assert!(state
            .start(Uuid::new_v4().to_string(), authorization(), 0)
            .is_err());
    }
    #[test]
    fn cancellation_and_expiry_release_listener_without_a_callback() {
        for cancel in [false, true] {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let address = listener.local_addr().unwrap();
            let cancelled = Arc::new(AtomicBool::new(false));
            let receiver = listen(
                listener,
                Callback::from_authorization(&authorization()).unwrap(),
                cancelled.clone(),
                Instant::now() + Duration::from_millis(80),
            )
            .unwrap();
            if cancel {
                cancelled.store(true, Ordering::SeqCst);
            }
            assert!(receiver.recv_timeout(Duration::from_secs(2)).is_err());
            assert!(TcpListener::bind(address).is_ok());
        }
    }
}
