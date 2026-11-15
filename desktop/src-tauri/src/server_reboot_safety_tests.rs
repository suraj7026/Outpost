use super::*;
use std::sync::{mpsc, Barrier};

fn set_boot(fixture: &Fixture, boot: &str) {
    let path = fixture
        .setup
        .ssh_fixture
        .as_ref()
        .expect("local SSH fixture required");
    fs::write(path, format!("#!/bin/sh\nfor arg do last=\"$arg\"; done\n[ \"$last\" = '/bin/cat /proc/sys/kernel/random/boot_id' ] || exit 90\nprintf '%s\\n' '{boot}'\n")).unwrap();
}

#[test]
fn close_waits_for_ssh_and_native_prompt_reaping_and_slot_cleanup() {
    for prompt in [false, true] {
        let fixture = fixture();
        let path = fixture.setup.directory.join("owned-child.pid");
        let worker_path = path.clone();
        let reboots = Arc::new(Reboots::default());
        let worker_reboots = reboots.clone();
        let (reaped_tx, reaped_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _slot = worker_reboots.slot().unwrap();
            let mut command = Command::new("/bin/sh");
            command.args([
                "-c",
                &format!("echo $$ > '{}'; exec /bin/sleep 60", worker_path.display()),
            ]);
            if prompt {
                assert!(authorization::run_prompt_command(
                    &mut command,
                    true,
                    &worker_reboots.cancelled,
                    Duration::from_secs(5)
                )
                .is_err());
            } else {
                assert!(capture(
                    &mut command,
                    &[],
                    &worker_reboots.cancelled,
                    Duration::from_secs(5)
                )
                .is_err());
            }
            reaped_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        });
        let started = Instant::now();
        let pid = loop {
            if let Some(pid) = fs::read_to_string(&path)
                .ok()
                .and_then(|s| s.trim().parse::<i32>().ok())
            {
                break pid;
            }
            assert!(started.elapsed() < Duration::from_secs(3));
            thread::sleep(Duration::from_millis(5));
        };
        let closing = reboots.clone();
        let (closed_tx, closed_rx) = mpsc::channel();
        let closer = thread::spawn(move || {
            closing.close();
            closed_tx.send(()).unwrap();
        });
        reaped_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        // No slot may enter after close's fence, even while it is still draining.
        assert!(reboots.slot().is_err());
        assert!(closed_rx.try_recv().is_err());
        // SAFETY: WNOHANG only inspects this process's child table. Cleanup already reaped it.
        assert_eq!(
            unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
        release_tx.send(()).unwrap();
        closed_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        worker.join().unwrap();
        closer.join().unwrap();
    }
}

#[test]
fn slot_acquisition_racing_shutdown_cannot_escape_the_drain() {
    for _ in 0..32 {
        let reboots = Arc::new(Reboots::default());
        let barrier = Arc::new(Barrier::new(9));
        let closed = Arc::new(AtomicBool::new(false));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let reboots = reboots.clone();
            let barrier = barrier.clone();
            let closed = closed.clone();
            workers.push(thread::spawn(move || {
                barrier.wait();
                if let Ok(_slot) = reboots.slot() {
                    thread::sleep(Duration::from_millis(1));
                    assert!(
                        !closed.load(Ordering::SeqCst),
                        "close returned with an admitted operation alive"
                    );
                }
            }));
        }
        barrier.wait();
        reboots.close();
        closed.store(true, Ordering::SeqCst);
        assert!(reboots.slot().is_err());
        for worker in workers {
            worker.join().unwrap();
        }
    }
}

#[test]
fn two_distinct_reviews_across_environments_and_host_aliases_dispatch_only_once() {
    const OTHER_ENV: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let first = fixture();
    let mut second = Fixture::for_environment(OTHER_ENV);
    second.fake_ssh(BOOT_A);
    let setup_id = terminal::resolve(&second.setup, &second.registry, Some(OTHER_ENV))
        .unwrap()
        .target
        .setup_id;
    second
        .setup
        .inner
        .lock()
        .unwrap()
        .entries
        .get_mut(&setup_id)
        .unwrap()
        .target
        .host = "alias.example".into();
    let reboots = Reboots::default();
    let a = reboots
        .review(&first.setup, &first.registry, Some(ENV))
        .unwrap();
    let b = reboots
        .review(&second.setup, &second.registry, Some(OTHER_ENV))
        .unwrap();
    assert_ne!(a.review_id, b.review_id);
    assert_ne!(a.target.setup_id, b.target.setup_id);
    assert_eq!(a.target.fingerprint, b.target.fingerprint);
    let barrier = Barrier::new(2);
    let count = AtomicUsize::new(0);
    let apply = |fixture: &Fixture, review: &Reviewed| {
        barrier.wait();
        reboots.apply_with(
            &fixture.setup,
            &fixture.registry,
            &review.review_id,
            &review.target.host,
            false,
            no_prompt,
            |_, _, _, _, _| {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(GUARD_OK.to_vec())
            },
        )
    };
    thread::scope(|scope| {
        let first = scope.spawn(|| apply(&first, &a));
        let second = scope.spawn(|| apply(&second, &b));
        let results = [first.join().unwrap(), second.join().unwrap()];
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
        assert_eq!(
            results.into_iter().find_map(Result::ok).unwrap().state,
            "unknown"
        );
    });
    assert_eq!(count.load(Ordering::SeqCst), 1);
    assert!(reboots
        .review(&first.setup, &first.registry, Some(ENV))
        .is_err());
    assert!(reboots
        .review(&second.setup, &second.registry, Some(OTHER_ENV))
        .is_err());
}

#[test]
fn uncertain_host_is_not_released_by_status_timeout_or_review_expiry() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            false,
            no_prompt,
            |_, _, _, _, _| Err("connection lost".into()),
        )
        .unwrap();
    reboots
        .reviews
        .lock()
        .unwrap()
        .get_mut(&id)
        .unwrap()
        .dispatched = Some(Instant::now() - STATUS_WINDOW);
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "unknown"
    );
    reboots.reviews.lock().unwrap().remove(&id);
    assert!(reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .is_err());
}

#[test]
fn verified_return_allows_only_a_fresh_review_of_the_new_generation() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let first = reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .unwrap()
        .review_id;
    let sibling = reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .unwrap()
        .review_id;
    let stale = reboots.reviews.lock().unwrap()[&sibling].clone();
    reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &first,
            "host.example",
            false,
            no_prompt,
            |_, _, _, _, _| Ok(acknowledged()),
        )
        .unwrap();
    assert!(reboots.reviews.lock().unwrap()[&sibling].consumed);
    set_boot(&fixture, BOOT_B);
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &first)
            .unwrap()
            .state,
        "returned"
    );
    // Even an unconsumed stale snapshot cannot evade the host's generation fence.
    reboots
        .reviews
        .lock()
        .unwrap()
        .insert(sibling.clone(), stale);
    assert!(reboots.consume(&sibling, "host.example").is_err());
    let fresh = reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .unwrap()
        .review_id;
    assert_eq!(reboots.reviews.lock().unwrap()[&fresh].boot_id, BOOT_B);
    assert_eq!(
        reboots
            .apply_with(
                &fixture.setup,
                &fixture.registry,
                &fresh,
                "host.example",
                false,
                no_prompt,
                |_, _, remote, _, _| {
                    assert_eq!(remote, reboot_command(BOOT_B, false).unwrap());
                    Ok(acknowledged())
                }
            )
            .unwrap()
            .state,
        "requested"
    );
}

#[test]
fn external_reboot_during_authorization_rejects_apply_before_dispatch() {
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
            set_boot(&fixture, BOOT_B);
            Ok(Zeroizing::new(b"secret\n".to_vec()))
        },
        |_, _, _, _, _| panic!("stale boot must not dispatch"),
    );
    assert!(result.unwrap_err().contains("boot ID changed"));
    assert!(reboots.reviews.lock().unwrap()[&id].dispatched.is_none());
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "unknown"
    );
    assert!(reboots.consume(&id, "host.example").is_err());
    assert!(reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .is_ok());
}

#[test]
fn remote_guard_rejection_is_not_requested_or_verified_and_does_not_retry() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    let result = reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            false,
            no_prompt,
            |_, _, remote, _, _| {
                assert_eq!(remote, reboot_command(BOOT_A, false).unwrap());
                set_boot(&fixture, BOOT_B);
                Ok(GUARD_REJECTED.to_vec())
            },
        )
        .unwrap();
    assert_eq!(result.state, "unknown");
    assert!(result.message.contains("No reboot was requested"));
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "unknown"
    );
    assert!(reboots.consume(&id, "host.example").is_err());
    assert!(reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .is_ok());
}

#[test]
fn missing_guard_ack_cannot_attribute_an_external_boot_to_failed_dispatch() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            false,
            no_prompt,
            |_, _, _, _, _| {
                set_boot(&fixture, BOOT_B);
                Err("SSH lost before guard acknowledgement".into())
            },
        )
        .unwrap();
    let status = reboots
        .status(&fixture.setup, &fixture.registry, &id)
        .unwrap();
    assert_eq!(status.state, "unknown");
    assert!(status.message.contains("cannot be attributed"));
    assert!(reboots
        .review(&fixture.setup, &fixture.registry, Some(ENV))
        .is_err());
}

#[test]
fn partial_guard_ack_survives_transport_failure_and_supports_read_only_verification() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let id = reviewed(&reboots, &fixture);
    let result = reboots
        .apply_with(
            &fixture.setup,
            &fixture.registry,
            &id,
            "host.example",
            false,
            no_prompt,
            |_, _, _, _, cancelled| {
                let mut command = Command::new("/bin/sh");
                command.args(["-c", "printf 'OUTPOST-REBOOT-GUARD-OK\\n'; exit 255"]);
                capture_inner(&mut command, &[], cancelled, Duration::from_secs(1), true)
            },
        )
        .unwrap();
    assert_eq!(result.state, "unknown");
    set_boot(&fixture, BOOT_B);
    assert_eq!(
        reboots
            .status(&fixture.setup, &fixture.registry, &id)
            .unwrap()
            .state,
        "returned"
    );
}

#[test]
fn remote_guard_prevents_the_action_when_the_boot_changes() {
    let fixture = fixture();
    let boot_path = fixture.setup.directory.join("fake-boot-id");
    let script = reboot_command(BOOT_A, false)
        .unwrap()
        .replace(
            "/proc/sys/kernel/random/boot_id",
            &format!("'{}'", boot_path.display()),
        )
        .replace(REBOOT, "printf 'FAKE-DISPATCH\\n'");
    assert!(!script.contains("sudo") && !script.contains("systemctl"));
    let run = || {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", &script]);
        capture(
            &mut command,
            &[],
            &AtomicBool::new(false),
            Duration::from_secs(1),
        )
        .unwrap()
    };
    fs::write(&boot_path, format!("{BOOT_B}\n")).unwrap();
    assert_eq!(run(), GUARD_REJECTED);
    fs::write(&boot_path, format!("{BOOT_A}\n")).unwrap();
    assert_eq!(run(), [GUARD_OK, b"FAKE-DISPATCH\n"].concat());
}

#[test]
fn canonical_host_reservation_ignores_environment_user_port_and_pin_replacement() {
    let fixture = fixture();
    let reboots = Reboots::default();
    let first = reviewed(&reboots, &fixture);
    let second = reviewed(&reboots, &fixture);
    {
        let mut reviews = reboots.reviews.lock().unwrap();
        let target = &mut reviews.get_mut(&second).unwrap().bound.target;
        target.host = "HOST.EXAMPLE.".into();
        target.user = "other-user".into();
        target.port = 2222;
        target.fingerprint = "different-verified-key".into();
    }
    let mut alias = fixture.bound().target;
    alias.host = "alias.example".into();
    reboots.review_generation(&alias).unwrap();
    let (_, reservation) = reboots.consume(&first, "host.example").unwrap();
    reservation.dispatch().unwrap();
    assert!(reboots.consume(&second, "HOST.EXAMPLE.").is_err());
    alias.fingerprint = "replacement-pin-on-an-observed-alias".into();
    assert!(reboots.review_generation(&alias).is_err());
}

#[test]
fn guarded_command_only_accepts_canonical_uuid_and_fixed_actions() {
    assert!(!allowed_remote(REBOOT));
    assert!(!allowed_remote(REBOOT_PASSWORD));
    for expected in [
        "",
        "not-a-uuid",
        "11111111-1111-4111-8111-111111111111' ; id",
        "11111111-1111-4111-8111-111111111111\n",
    ] {
        assert!(reboot_command(expected, false).is_err());
    }
    for password in [true, false] {
        let command = reboot_command(BOOT_A, password).unwrap();
        assert!(allowed_remote(&command));
        assert!(!allowed_remote(&(command.clone() + "; id")));
        assert!(command.find(BOOT_A).unwrap() < command.find("/usr/bin/sudo").unwrap());
        // -n parses shell syntax only; no commands, SSH, sudo or reboot are executed.
        assert!(Command::new("/bin/sh")
            .args(["-n", "-c", &command])
            .status()
            .unwrap()
            .success());
    }
}
