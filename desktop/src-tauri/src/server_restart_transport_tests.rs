use super::*;

const ECHO: &str = r#"import signal, sys
assert __name__ == "__main__"
assert sys.argv == ["-c"]
assert sys.flags.isolated and sys.flags.no_site and sys.flags.dont_write_bytecode
assert signal.getitimer(signal.ITIMER_REAL) == (0.0, 0.0)
label = "π — 鍵 🔒"
sys.stdout.buffer.write(sys.stdin.buffer.read())"#;

fn local_bootstrap(command: &str, frame: &[u8]) -> Result<Vec<u8>, String> {
    // Only a local interpreter and synthetic helper; never SSH, sudo, or the real helper main.
    run_bounded(
        "/bin/sh",
        &["-c".into(), command.into()],
        frame,
        Duration::from_secs(8),
        &AtomicBool::new(false),
        MAX_REPLY,
    )
}

#[test]
fn recovery_modes_reuse_review_and_apply_budgets_without_status_fallback() {
    assert_eq!(helper_timeout("recover_review"), helper_timeout("review"));
    assert_eq!(helper_timeout("recover_apply"), helper_timeout("apply"));
    assert_eq!(
        helper_timeout("recover_review"),
        Duration::from_secs(120 + 20)
    );
    assert_eq!(
        helper_timeout("recover_apply"),
        Duration::from_secs(300 + 20)
    );
}

#[test]
fn bootstrap_command_is_short_and_contains_only_loader_and_trusted_metadata() {
    let source = HELPER.as_bytes();
    let source_length = source.len();
    let source_digest = format!("{:x}", Sha256::digest(source));
    let command = helper_command().unwrap();
    assert!(command.starts_with("/usr/bin/python3 -I -B -S -c '"));
    let (prefix, declared_digest) = command.rsplit_once(' ').unwrap();
    let (_, declared_length) = prefix.rsplit_once(' ').unwrap();
    let declared_length = declared_length.parse::<usize>().unwrap();
    assert_eq!(declared_length, source_length);
    assert_eq!(declared_digest, source_digest);
    for password in [&b""[..], &b"fixture-secret\n"[..]] {
        let frame = helper_frame(Zeroizing::new(password.to_vec()), source, b"{}").unwrap();
        let source_start = password.len();
        let packet_start = source_start + declared_length;
        assert!(frame[..source_start] == *password);
        assert_eq!(&frame[source_start..packet_start], source);
        assert_eq!(
            format!("{:x}", Sha256::digest(&frame[source_start..packet_start])),
            declared_digest
        );
        assert_eq!(&frame[packet_start..], b"{}\n");
    }
    assert!(command.contains(&STANDARD.encode(BOOTSTRAP)));
    assert!(!command.contains(&STANDARD.encode(source)));
    assert!(!command.contains("fixture-secret"));
    assert!(!command.contains("resetId"));
    for privilege in ["", "sudo -n -- ", PASSWORD_PRIVILEGE] {
        assert!(privilege.len() + command.len() < MAX_RESTART_COMMAND);
    }
    let grown = vec![b'#'; MAX_HELPER_BYTES];
    let legacy = format!(
        "/usr/bin/python3 -I -B -S -c 'import base64;exec(base64.b64decode(\"{}\"))'",
        STANDARD.encode(&grown)
    );
    assert!(
        legacy.len() > 32 * 4096,
        "regression must cover Linux MAX_ARG_STRLEN"
    );
    let grown_command = helper_command_for(&grown).unwrap();
    assert!(grown_command.len() + PASSWORD_PRIVILEGE.len() < MAX_RESTART_COMMAND);
    assert_eq!(
        grown_command.len(),
        command.len() - source_length.to_string().len() + MAX_HELPER_BYTES.to_string().len()
    );
    assert!(helper_command_for(&[]).is_err());
    assert!(helper_command_for(&vec![0; MAX_HELPER_BYTES + 1]).is_err());
}

#[test]
fn frame_is_preallocated_password_then_exact_source_then_bounded_packet() {
    let packet = br#"{"mode":"status","canary":"packet-secret-not-an-argument"}"#;
    assert!(ECHO.len() > ECHO.chars().count());
    for password in [&b""[..], &b"fixture-secret\n"[..]] {
        let mut frame =
            helper_frame(Zeroizing::new(password.to_vec()), ECHO.as_bytes(), packet).unwrap();
        let source_start = password.len();
        let packet_start = source_start + ECHO.len();
        assert_eq!(frame.len(), packet_start + packet.len() + 1);
        assert_eq!(frame.capacity(), frame.len());
        assert!(frame[..source_start] == *password);
        assert!(frame[source_start..packet_start] == *ECHO.as_bytes());
        assert!(frame[packet_start..frame.len() - 1] == *packet);
        assert_eq!(frame.last(), Some(&b'\n'));
        let command = helper_command_for(ECHO.as_bytes()).unwrap();
        assert!(!command.contains("fixture-secret"));
        assert!(!command.contains("packet-secret-not-an-argument"));
        assert!(!command.contains("π"));
        frame.fill(0);
        assert!(frame.iter().all(|b| *b == 0));
    }
    let maximum = helper_frame(
        Zeroizing::new(Vec::new()),
        ECHO.as_bytes(),
        &vec![b' '; MAX_PACKET - 1],
    )
    .unwrap();
    assert_eq!(maximum.len() - ECHO.len(), 16384);
    assert!(helper_frame(
        Zeroizing::new(Vec::new()),
        ECHO.as_bytes(),
        &vec![b' '; MAX_PACKET]
    )
    .is_err());
    for password in [
        b"missing-newline".as_slice(),
        b"two\nlines\n",
        b"carriage\r\n",
    ] {
        let error =
            helper_frame(Zeroizing::new(password.to_vec()), ECHO.as_bytes(), packet).unwrap_err();
        assert!(error.starts_with("[restartTransport:passwordFrame]"));
        assert!(!error.contains(std::str::from_utf8(password).unwrap()));
    }
}

#[test]
fn real_native_bootstrap_preserves_packet_unicode_flags_and_argv() {
    for packet in [
        br#"{"mode":"status","value":"packet-canary"}"#.to_vec(),
        vec![b' '; MAX_PACKET - 1],
    ] {
        let command = helper_command_for(ECHO.as_bytes()).unwrap();
        let frame = helper_frame(Zeroizing::new(Vec::new()), ECHO.as_bytes(), &packet).unwrap();
        let output = local_bootstrap(&command, &frame).unwrap();
        let mut expected = packet;
        expected.push(b'\n');
        assert!(output == expected);
    }
    let mut grown = ECHO.as_bytes().to_vec();
    grown.extend_from_slice(b"\n#");
    grown.resize(MAX_HELPER_BYTES, b'x');
    let frame = helper_frame(Zeroizing::new(Vec::new()), &grown, b"{}").unwrap();
    assert!(local_bootstrap(&helper_command_for(&grown).unwrap(), &frame).unwrap() == b"{}\n");
}

#[test]
fn wrong_hash_and_truncated_source_never_execute_the_synthetic_helper() {
    let f = fixture();
    let marker = f.root.join("bootstrap-executed");
    let source = format!(
        "# verified source\nfrom pathlib import Path\nPath({}).write_text('executed')\n{ECHO}",
        serde_json::to_string(&marker.to_string_lossy()).unwrap()
    );
    let command = helper_command_for(source.as_bytes()).unwrap();
    let valid = helper_frame(Zeroizing::new(Vec::new()), source.as_bytes(), b"{}").unwrap();
    let mut wrong_hash = valid.to_vec();
    wrong_hash[2] ^= 1; // A valid comment change: compilation alone would not prevent execution.
    let wrong_metadata = format!("{} {}", command.rsplit_once(' ').unwrap().0, "0".repeat(64));
    assert!(local_bootstrap(&wrong_metadata, &valid).is_err());
    assert!(!marker.exists());
    let truncated = source.as_bytes()[..source.len() - 1].to_vec();
    let shifted = [&truncated[..], b"{}\n"].concat();
    for invalid in [&wrong_hash, &truncated, &shifted] {
        assert!(local_bootstrap(&command, invalid).is_err());
        assert!(!marker.exists());
    }
    assert!(local_bootstrap(&command, &valid).unwrap() == b"{}\n");
    assert!(
        marker.exists(),
        "positive control must execute the verified helper"
    );
}

#[test]
fn synthetic_ssh_rejects_legacy_json_only_and_unverified_prefixes() {
    let f = fixture();
    let packet = serde_json::to_vec(
        &json!({"mode":"review","resetId":Uuid::new_v4().to_string(),
        "expected":Expected::from_entry(&f.entry).unwrap()}),
    )
    .unwrap();
    let mut args = f.setup.ssh_args(&f.entry).unwrap();
    args.extend([
        "--".into(),
        f.entry.target.host.clone(),
        format!("sudo -n -- {}", helper_command().unwrap()),
    ]);
    let valid = helper_frame(Zeroizing::new(Vec::new()), HELPER.as_bytes(), &packet).unwrap();
    let mut wrong_hash = valid.to_vec();
    wrong_hash[0] ^= 1;
    let truncated = [&HELPER.as_bytes()[..HELPER.len() - 1], &packet].concat();
    for invalid in [&packet, &wrong_hash, &truncated] {
        assert!(run_bounded(
            f.setup.ssh_program(),
            &args,
            invalid,
            Duration::from_secs(5),
            &AtomicBool::new(false),
            MAX_REPLY
        )
        .is_err());
        assert!(calls(&f).is_empty());
    }
    assert!(run_bounded(
        f.setup.ssh_program(),
        &args,
        &valid,
        Duration::from_secs(5),
        &AtomicBool::new(false),
        MAX_REPLY
    )
    .is_ok());
    assert_eq!(calls(&f).len(), 1);
}
