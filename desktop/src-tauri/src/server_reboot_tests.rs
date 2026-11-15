use super::*;
use std::sync::atomic::AtomicUsize;
use terminal::tests::{Fixture, ENV};

#[path = "server_reboot_safety_tests.rs"]
mod safety;

const BOOT_A: &str = "11111111-1111-4111-8111-111111111111";
const BOOT_B: &str = "22222222-2222-4222-8222-222222222222";
fn fixture() -> Fixture {
    let mut fixture = Fixture::new();
    fixture.fake_ssh(BOOT_A);
    fixture
}
fn acknowledged() -> Vec<u8> {
    [GUARD_OK, ACK].concat()
}
fn reviewed(reboots: &Reboots, fixture: &Fixture) -> String {
    let id = Uuid::new_v4().to_string();
    let generation = reboots.review_generation(&fixture.bound().target).unwrap();
    reboots.reviews.lock().unwrap().insert(
        id.clone(),
        Review {
            bound: fixture.bound(),
            boot_id: BOOT_A.into(),
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
    id
}
fn no_prompt(_: &Target, _: &AtomicBool) -> Result<Zeroizing<Vec<u8>>, String> {
    panic!("unexpected native prompt")
}

#[test]
fn exact_confirmation_freshness_and_single_use_are_native_enforced() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    for confirmation in [
        "",
        "HOST.EXAMPLE",
        "host.example ",
        "operator@host.example",
        "another.host",
    ] {
        assert!(reboots.consume(&id, confirmation).is_err());
    }
    assert!(reboots.consume(&id, "host.example").is_ok());
    assert!(reboots.consume(&id, "host.example").is_err());
    let expired = reviewed(&reboots, &fixture);
    reboots
        .reviews
        .lock()
        .unwrap()
        .get_mut(&expired)
        .unwrap()
        .created = Instant::now() - REVIEW_TTL;
    assert!(reboots.consume(&expired, "host.example").is_err());
}

#[test]
fn simultaneous_apply_claims_dispatch_only_once() {
    let fixture = fixture();
    let reboots = Arc::new(Reboots::default());
    let id = reviewed(&reboots, &fixture);
    let threads: Vec<_> = (0..16)
        .map(|_| {
            let reboots = reboots.clone();
            let id = id.clone();
            thread::spawn(move || reboots.consume(&id, "host.example").is_ok())
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|t| usize::from(t.join().unwrap()))
            .sum::<usize>(),
        1
    );
}

#[test]
fn native_cancel_consumes_review_but_never_dispatches() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    let count = AtomicUsize::new(0);
    let result = reboots.apply_with(
        &fixture.setup,
        &fixture.registry,
        &id,
        "host.example",
        true,
        |_, _| Err("[localAuthorization:userCancel] Cancelled".into()),
        |_, _, _, _, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Ok(acknowledged())
        },
    );
    assert!(result.unwrap_err().contains("userCancel"));
    assert_eq!(count.load(Ordering::SeqCst), 0);
    assert!(reboots.consume(&id, "host.example").is_err());
    assert!(reboots.reviews.lock().unwrap()[&id].dispatched.is_none());
}

#[test]
fn password_only_enters_stdin_and_review_is_consumed_before_dispatch() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    let result = reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            true,
            |_, _| Ok(Zeroizing::new(b"private-password\n".to_vec())),
            |_, _, remote, input, _| {
                assert_eq!(remote, reboot_command(BOOT_A, true).unwrap());
                assert!(!remote.contains("private-password"));
                assert_eq!(input, b"private-password\n");
                assert!(reboots.reviews.lock().unwrap()[&id].consumed);
                assert!(reboots.reviews.lock().unwrap()[&id].dispatched.is_some());
                Ok(acknowledged())
            },
        )
        .unwrap();
    assert_eq!(result.state, "requested");
    assert!(!result.message.contains("private-password"));
}

#[test]
fn lost_connection_is_unknown_and_never_replayed() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    let count = AtomicUsize::new(0);
    let dispatch = |_: &Setup, _: &BoundTarget, remote: &str, input: &[u8], _: &AtomicBool| {
        count.fetch_add(1, Ordering::SeqCst);
        assert_eq!(remote, reboot_command(BOOT_A, false).unwrap());
        assert!(input.is_empty());
        Err("connection closed secret output must not escape".into())
    };
    let result = reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            false,
            no_prompt,
            dispatch,
        )
        .unwrap();
    assert_eq!(result.state, "unknown");
    assert!(!result.message.contains("secret output"));
    assert!(reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            false,
            no_prompt,
            dispatch
        )
        .is_err());
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[test]
fn trust_change_during_prompt_blocks_dispatch() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    let result = reboots.apply_with(
        &fixture.setup,
        &fixture.registry,
        &id,
        "host.example",
        true,
        |_, _| {
            fixture.break_pin();
            Ok(Zeroizing::new(b"secret\n".to_vec()))
        },
        |_, _, _, _, _| panic!("trust changed; must not dispatch"),
    );
    assert!(result.is_err());
    assert!(reboots.reviews.lock().unwrap()[&id].dispatched.is_none());
}

#[test]
fn cancellation_and_expiry_during_prompt_block_dispatch() {
    for cancel in [true, false] {
        let fixture = fixture();
        let reboots = Reboots::default();
        let id = reviewed(&reboots, &fixture);
        if !cancel {
            reboots
                .reviews
                .lock()
                .unwrap()
                .get_mut(&id)
                .unwrap()
                .created = Instant::now() - REVIEW_TTL + Duration::from_millis(40);
        }
        assert!(reboots
            .apply_with(
                &fixture.setup,
                &fixture.registry,
                &id,
                "host.example",
                true,
                |_, _| {
                    if cancel {
                        reboots.cancel();
                    } else {
                        thread::sleep(Duration::from_millis(70));
                    }
                    Ok(Zeroizing::new(b"secret\n".to_vec()))
                },
                |_, _, _, _, _| panic!("cancelled or expired; must not dispatch")
            )
            .is_err());
        assert!(reboots.reviews.lock().unwrap()[&id].dispatched.is_none());
    }
}

#[test]
fn only_changed_boot_id_proves_return_and_status_never_resends_reboot() {
    let mut fixture = fixture();
    fixture.fake_ssh(BOOT_A);
    let reboots = Reboots::default();
    let review = reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .unwrap();
    assert_eq!(review.target.host, "host.example");
    let id = review.review_id;
    reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            false,
            no_prompt,
            |_, _, _, _, _| Ok(acknowledged()),
        )
        .unwrap();
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "waiting"
    );
    fixture.fake_ssh(BOOT_B);
    // The five-second throttle must not run another SSH check immediately.
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "waiting"
    );
    reboots
        .reviews
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .last_check = None;
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "returned"
    );
    fixture.fake_ssh("invalid");
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "returned"
    );
    assert!(reboots.consume(&id, "host.example").is_err());
    assert_eq!(BOOT_ID, "/bin/cat /proc/sys/kernel/random/boot_id");
    assert!(!BOOT_ID.contains("sudo"));
}

#[test]
fn verification_window_is_bounded_and_missing_review_is_unknown() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    reboots
        .reviews
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .dispatched = Some(Instant::now() - STATUS_WINDOW);
    // No SSH fixture: this must short-circuit without ever connecting to a host.
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "unknown"
    );
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, "absent")
            .unwrap()
            .state,
        "unknown"
    );
}

#[test]
fn boot_id_parser_rejects_banners_and_malformed_ids() {
    assert_eq!(
        parse_boot(format!("{BOOT_A}\n").as_bytes()).unwrap(),
        BOOT_A
    );
    for bytes in [
        b"".as_slice(),
        b"not-a-uuid",
        b"00000000-0000-0000-0000-000000000000\n",
        b"banner\n11111111-1111-4111-8111-111111111111\n",
        b"\xff",
    ] {
        assert!(parse_boot(bytes).is_err());
    }
}

#[test]
fn protected_prompt_is_reboot_specific_and_cancel_is_default() {
    let fixture = fixture();
    let script = prompt_script(&fixture.bound().target);
    assert!(script.contains("with hidden answer"));
    assert!(script.contains("default button \"Cancel\""));
    assert!(script.contains("Outpost server reboot"));
    assert!(script.contains("operator@host.example:22"));
    assert!(!script.contains("Remove native installation"));
    #[cfg(target_os = "macos")]
    {
        let directory = super::super::tests::root();
        let output = Command::new("/usr/bin/osacompile")
            .args(["-o"])
            .arg(directory.join("reboot.scpt"))
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "reboot AppleScript must compile without displaying a dialog"
        );
        fs::remove_dir_all(directory).unwrap();
    }
}

#[test]
fn local_capture_is_bounded_cancellable_and_does_not_surface_auth_output() {
    let cancel = AtomicBool::new(false);
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "printf '11111111-1111-4111-8111-111111111111\\n'"]);
    assert_eq!(
        parse_boot(&capture(&mut command, &[], &cancel, Duration::from_secs(1)).unwrap()).unwrap(),
        BOOT_A
    );
    let mut overflow = Command::new("/usr/bin/yes");
    overflow.arg("secret");
    let error = capture(&mut overflow, &[], &cancel, Duration::from_secs(1)).unwrap_err();
    assert!(error.contains("limit"));
    assert!(!error.contains("secret"));
    let mut sleeping = Command::new("/bin/sleep");
    sleeping.arg("60");
    let started = Instant::now();
    assert!(capture(&mut sleeping, &[], &cancel, Duration::from_millis(40)).is_err());
    assert!(started.elapsed() < Duration::from_secs(2));
    cancel.store(true, Ordering::SeqCst);
    let mut unavailable = Command::new("/not/a/program");
    assert!(
        capture(&mut unavailable, &[], &cancel, Duration::from_secs(1))
            .unwrap_err()
            .contains("before dispatch")
    );
}
