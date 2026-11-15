use super::*;
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

const CANARY: &str = "auth-secret-canary-do-not-display";

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("outpost-prompt-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Self(path)
    }
    fn command(&self, body: &str) -> Command {
        // Synthetic fixture output only; never a real credential. No fixture password in argv.
        let path = self.0.join("prompt-fixture");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let mut command = Command::new("/bin/sh");
        command.arg(path).current_dir(&self.0);
        command
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn run(command: &mut Command, password: bool) -> Result<Secret, Error> {
    run_prompt_command(
        command,
        password,
        &AtomicBool::new(false),
        Duration::from_secs(5),
    )
}
fn assert_safe(error: Error) {
    for text in [format!("{error}"), format!("{error:?}")] {
        assert!(!text.contains(CANARY));
        assert!(!text.contains("wrong password"));
        assert!(!text.contains("SSH identity"));
    }
}

#[test]
fn purpose_defaults_and_script_never_contain_a_secret_or_external_automation() {
    for purpose in [
        Purpose::Review,
        Purpose::RecoveryReview,
        Purpose::Stop,
        Purpose::Apply,
    ] {
        for password in [false, true] {
            let script = script(purpose, "operator@example.test:22", password);
            let default = if purpose == Purpose::Review {
                purpose.button()
            } else {
                "Cancel"
            };
            assert!(script.contains(&format!("default button \"{default}\"")));
            assert!(script.contains("cancel button \"Cancel\""));
            assert!(script.contains(&format!("giving up after {DIALOG_SECONDS}")));
            assert!(script.contains("if gave up of dialogReply"));
            assert!(script.contains("tell current application to activate"));
            assert!(script.contains("on error number errorNumber"));
            assert_eq!(script.contains("hidden answer"), password);
            assert!(!script.contains(CANARY));
            for forbidden in ["System Events", "Finder", "do shell script", "errorMessage"] {
                assert!(!script.contains(forbidden));
            }
        }
    }
    assert!(PROCESS_TIMEOUT > Duration::from_secs(DIALOG_SECONDS));
    assert_eq!(Purpose::from_mode("install"), Err(Error::InvalidResponse));
    assert_eq!(
        Purpose::from_mode("recover_review"),
        Ok(Purpose::RecoveryReview)
    );
    let recovery = script(Purpose::RecoveryReview, "operator@example.test:22", true);
    assert!(recovery.contains("Prepare held reset review"));
    assert!(recovery.contains("write a recovery preparation receipt"));
    assert!(recovery.contains("default button \"Cancel\""));
    assert!(recovery.contains("Removal requires another explicit approval"));
}

#[test]
fn strict_envelopes_preserve_password_bytes_without_debug_disclosure() {
    assert!(parse_output(b"OUTPOST-AUTH/1:approved\n", false)
        .unwrap()
        .into_input()
        .is_empty());
    for password in [CANARY, "  spaced \"quoted\" \\ password  ", "sëcret-鍵"] {
        let frame = Zeroizing::new(format!("{PREFIX}approved\n{password}\n").into_bytes());
        let secret = parse_output(&frame, true).unwrap();
        assert_eq!(format!("{secret:?}"), "Secret([REDACTED])");
        assert!(secret.into_input().as_slice() == format!("{password}\n").as_bytes());
    }
    for (frame, expected) in [
        ("userCancel", Error::UserCancel),
        ("timeout", Error::Timeout),
        ("invalidResponse", Error::InvalidResponse),
        (
            "processFailure:-1743",
            Error::ProcessFailure {
                phase: ProcessPhase::AppleScript,
                code: Some(-1743),
            },
        ),
    ] {
        for password in [false, true] {
            let error =
                parse_output(format!("{PREFIX}{frame}\n").as_bytes(), password).unwrap_err();
            assert_eq!(error, expected);
            assert_safe(error);
        }
    }
    for frame in [
        "",
        "Cancel\n",
        "Review removal scope\n",
        "OUTPOST-AUTH/2:approved\n",
        "OUTPOST-AUTH/1:approved",
        "OUTPOST-AUTH/1:approved\n\n",
        "OUTPOST-AUTH/1:userCancel\nextra\n",
        "OUTPOST-AUTH/1:processFailure:+1\n",
        "OUTPOST-AUTH/1:processFailure:001\n",
        "OUTPOST-AUTH/1:processFailure:2147483648\n",
        "OUTPOST-AUTH/1:approved\nline\nbreak\n",
        "OUTPOST-AUTH/1:approved\ncarriage\r\n",
        "OUTPOST-AUTH/1:approved\ncontrol\u{7f}\n",
        "OUTPOST-AUTH/1:approved\ncontrol\u{85}\n",
    ] {
        for password in [false, true] {
            assert_eq!(
                parse_output(frame.as_bytes(), password).unwrap_err(),
                Error::InvalidResponse
            );
        }
    }
    assert_eq!(
        parse_output(b"OUTPOST-AUTH/1:approved\n\xff\n", true).unwrap_err(),
        Error::InvalidResponse
    );
    assert_eq!(
        parse_output(b"OUTPOST-AUTH/1:approved\n", true).unwrap_err(),
        Error::InvalidResponse
    );
    let maximum = format!("{PREFIX}approved\n{}\n", "x".repeat(MAX_PASSWORD));
    assert_eq!(
        parse_output(maximum.as_bytes(), true)
            .unwrap()
            .into_input()
            .len(),
        MAX_PASSWORD + 1
    );
    let oversized = format!("{PREFIX}approved\n{}\n", "x".repeat(MAX_PASSWORD + 1));
    assert_eq!(
        parse_output(oversized.as_bytes(), true).unwrap_err(),
        Error::InvalidResponse
    );
}

#[test]
fn injected_process_outputs_are_typed_and_stderr_is_never_an_outcome() {
    let f = Fixture::new();
    for (body, password, expected) in [
        (
            format!("printf '{PREFIX}userCancel\\n'"),
            false,
            Error::UserCancel,
        ),
        (format!("printf '{PREFIX}timeout\\n'"), true, Error::Timeout),
        (
            format!("printf '{PREFIX}processFailure:-1712\\n'"),
            false,
            Error::ProcessFailure {
                phase: ProcessPhase::AppleScript,
                code: Some(-1712),
            },
        ),
        (
            format!("printf '{CANARY}\\n'; printf '{CANARY} (-128)\\n' >&2"),
            true,
            Error::InvalidResponse,
        ),
        (
            format!("printf '{PREFIX}userCancel\\n'; printf '{CANARY} (-128)\\n' >&2; exit 7"),
            false,
            Error::ProcessFailure {
                phase: ProcessPhase::Exit,
                code: Some(7),
            },
        ),
        (
            format!("printf '{CANARY}\\n' >&2; exit 1"),
            true,
            Error::ProcessFailure {
                phase: ProcessPhase::Exit,
                code: Some(1),
            },
        ),
    ] {
        let error = run(&mut f.command(&body), password).unwrap_err();
        assert_eq!(error, expected);
        assert_safe(error);
    }
    let mut command = f.command(&format!(
        "printf '{PREFIX}approved\\n{CANARY}\\n'; printf '{CANARY}\\n' >&2"
    ));
    assert!(!format!("{command:?}").contains(CANARY));
    let secret = run(&mut command, true).unwrap();
    assert!(!format!("{secret:?}").contains(CANARY));
    assert!(secret.into_input().as_slice() == format!("{CANARY}\n").as_bytes());
    assert!(run(
        &mut f.command(&format!("printf '{PREFIX}approved\\n'")),
        false
    )
    .unwrap()
    .into_input()
    .is_empty());

    let missing = f.0.join("does-not-exist");
    assert_eq!(
        run(&mut Command::new(missing), false).unwrap_err(),
        Error::Unavailable
    );
    let denied = f.0.join("not-executable");
    fs::write(&denied, b"fixture").unwrap();
    fs::set_permissions(&denied, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(
        run(&mut Command::new(denied), false).unwrap_err(),
        process_error(ProcessPhase::Spawn)
    );
}

fn assert_reaped(f: &Fixture) {
    let pid = fs::read_to_string(f.0.join("pid")).unwrap();
    let pid: i32 = pid.trim().parse().unwrap();
    unsafe extern "C" {
        fn waitpid(pid: i32, status: *mut i32, options: i32) -> i32;
    }
    let mut status = 0;
    // -1 (ECHILD) distinguishes reaping from merely killing a still-waitable zombie.
    assert_eq!(unsafe { waitpid(pid, &mut status, 1) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(10)); // ECHILD on macOS/Linux
}

#[test]
fn timeout_and_overflow_kill_and_reap_the_owned_prompt() {
    for overflow in [false, true] {
        let f = Fixture::new();
        let body = if overflow {
            "echo $$ > pid\nwhile :; do printf 'auth-secret-canary-do-not-display'; done"
        } else {
            "echo $$ > pid\nexec /bin/sleep 30"
        };
        let start = Instant::now();
        let error = run_prompt_command(
            &mut f.command(body),
            true,
            &AtomicBool::new(false),
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert_eq!(
            error,
            if overflow {
                Error::InvalidResponse
            } else {
                Error::Timeout
            }
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        assert_safe(error);
        assert_reaped(&f);
    }
}

#[test]
fn request_cancellation_before_spawn_and_during_partial_secret_output_reaps_prompt() {
    let f = Fixture::new();
    let cancelled = AtomicBool::new(true);
    let mut command = f.command("echo spawned > started");
    assert_eq!(
        run_prompt_command(&mut command, false, &cancelled, Duration::from_secs(2)).unwrap_err(),
        Error::RequestCancel
    );
    assert!(!f.0.join("started").exists());
    cancelled.store(false, Ordering::SeqCst);
    let mut command = f.command(&format!(
        "echo $$ > pid\nprintf '{PREFIX}approved\\n{CANARY}'\nexec /bin/sleep 30"
    ));
    thread::scope(|scope| {
        let handle = scope
            .spawn(|| run_prompt_command(&mut command, true, &cancelled, Duration::from_secs(3)));
        let start = Instant::now();
        while !f.0.join("pid").exists() && start.elapsed() < Duration::from_secs(2) {
            thread::sleep(Duration::from_millis(5));
        }
        assert!(f.0.join("pid").exists());
        cancelled.store(true, Ordering::SeqCst);
        let error = handle.join().unwrap().unwrap_err();
        assert_eq!(error, Error::RequestCancel);
        assert_safe(error);
    });
    assert_reaped(&f);
    cancelled.store(false, Ordering::SeqCst);
    assert!(run(
        &mut f.command(&format!("printf '{PREFIX}approved\\n'")),
        false
    )
    .is_ok());
}

#[test]
fn inherited_open_output_cannot_turn_deadline_into_an_unbounded_reader_join() {
    let f = Fixture::new();
    // A short-lived descendant retains stdout beyond the owned prompt's successful exit.
    // The runner must not block waiting for its EOF.
    let mut command = f.command("echo $$ > pid\n/bin/sleep 1 &\nexit 0");
    let start = Instant::now();
    let error = run_prompt_command(
        &mut command,
        false,
        &AtomicBool::new(false),
        Duration::from_millis(100),
    )
    .unwrap_err();
    assert_eq!(error, Error::Timeout);
    assert!(start.elapsed() < Duration::from_millis(800));
    assert_reaped(&f);
    thread::sleep(Duration::from_secs(1)); // Let the synthetic descriptor holder exit too.
}

#[cfg(target_os = "macos")]
#[test]
fn real_applescript_compiler_accepts_every_prompt_without_executing_dialogs() {
    let f = Fixture::new();
    for purpose in [
        Purpose::Review,
        Purpose::RecoveryReview,
        Purpose::Stop,
        Purpose::Apply,
    ] {
        for password in [false, true] {
            let mut command = Command::new("/usr/bin/osacompile");
            command
                .arg("-o")
                .arg(f.0.join("compiled.scpt"))
                .arg("-e")
                .arg(script(purpose, "operator@example.test:22", password));
            capture(
                &mut command,
                &AtomicBool::new(false),
                Duration::from_secs(10),
            )
            .unwrap();
        }
    }
    // The former prompt grammar also compiles: do not claim a syntax error caused the
    // operator's click without evidence from that invocation.
    for password in [false, true] {
        let prefix = if password {
            "text returned of "
        } else {
            "button returned of "
        };
        let field = if password {
            " default answer \"\" with hidden answer"
        } else {
            ""
        };
        let legacy = format!("{prefix}(display dialog \"Compile-only legacy review\"{field} buttons {{\"Cancel\", \"Review removal scope\"}} default button \"Cancel\" with title \"Outpost setup restart\")");
        let mut command = Command::new("/usr/bin/osacompile");
        command
            .arg("-o")
            .arg(f.0.join("legacy.scpt"))
            .arg("-e")
            .arg(legacy);
        capture(
            &mut command,
            &AtomicBool::new(false),
            Duration::from_secs(10),
        )
        .unwrap();
    }
    let mut command = Command::new("/usr/bin/osacompile");
    command
        .arg("-o")
        .arg(f.0.join("escaped.scpt"))
        .arg("-e")
        .arg(script(Purpose::Review, "quoted \"target\" \\ \r\n", true));
    capture(
        &mut command,
        &AtomicBool::new(false),
        Duration::from_secs(10),
    )
    .unwrap();
}

#[cfg(target_os = "macos")]
#[test]
fn real_osascript_executes_status_envelopes_with_dialog_and_activation_removed() {
    for (replacement, password, expected) in [
        ("set dialogReply to {button returned:\"Review removal scope\", gave up:false}", false, None),
        ("set dialogReply to {button returned:\"Review removal scope\", text returned:\"synthetic-only\", gave up:false}", true, None),
        ("set dialogReply to {button returned:\"\", gave up:true}", false, Some(Error::Timeout)),
        ("error number -128", true, Some(Error::UserCancel)),
        ("error number -1743", false, Some(Error::ProcessFailure { phase: ProcessPhase::AppleScript, code: Some(-1743) })),
        ("set dialogReply to {button returned:\"unexpected\", gave up:false}", false, Some(Error::InvalidResponse)),
    ] {
        let source = script(Purpose::Review, "fixture@example.test:22", password);
        let stub = source.lines().map(|line| {
            if line.contains("tell current application to activate") { "-- No focus change in tests." }
            else if line.contains("set dialogReply to (display dialog ") { replacement }
            else { line }
        }).collect::<Vec<_>>().join("\n");
        // Refuse to execute if the test substitution ever stops removing the UI operations.
        assert!(!stub.contains("display dialog"));
        assert!(!stub.contains("activate"));
        let mut command = Command::new("/usr/bin/osascript");
        command.args(["-s", "he", "-e", &stub]);
        let result = run(&mut command, password);
        if let Some(expected) = expected { assert_eq!(result.unwrap_err(), expected); }
        else {
            let secret = result.unwrap().into_input();
            let expected: &[u8] = if password { b"synthetic-only\n" } else { b"" };
                        assert!(secret.as_slice() == expected);
        }
    }
}
