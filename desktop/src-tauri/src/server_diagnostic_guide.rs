//! Offline runbook from validated saved identity; commands are never executed here.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guide {
    destination: String,
    fingerprint: String,
    steps: Vec<Step>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    id: String,
    title: String,
    command: String,
    detail: String,
    privileged: bool,
    run_on: &'static str,
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn command(args: &[String]) -> String {
    args.iter()
        .map(|arg| quote(arg))
        .collect::<Vec<_>>()
        .join(" ")
}
fn read_command(binding: &Binding, file: &str, limit: usize, private: bool) -> String {
    // Same descriptor anchoring as collection. Nothing is imported from the server
    // operation directory, and sudo only authorizes this bounded read.
    let script = format!(r#"import os,stat,json
parts=['var','lib','outpost-setup','operations',{}]
expected={}
flags=getattr(os,'O_PATH',os.O_RDONLY)|os.O_DIRECTORY|os.O_NOFOLLOW
fd=os.open('/',flags)
def check(fd,directory,private=False):
 s=os.fstat(fd)
 assert (stat.S_ISDIR(s.st_mode) if directory else stat.S_ISREG(s.st_mode)) and s.st_uid==0 and not s.st_mode&(0o077 if private else 0o022), 'Unsafe owner/type/permissions'
 assert directory or s.st_nlink==1, 'Unsafe hard link'
check(fd,True)
for part in parts:
 child=os.open(part,flags,dir_fd=fd);os.close(fd);fd=child;check(fd,True)
def read(name,limit,private=False):
 s=os.stat(name,dir_fd=fd,follow_symlinks=False)
 assert stat.S_ISREG(s.st_mode), 'Not a regular file'
 f=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 try:
  check(f,False,private)
  s=os.fstat(f)
  assert private or s.st_size<=limit, 'Oversized receipt'
  if private: os.lseek(f,max(0,s.st_size-limit),os.SEEK_SET)
  return os.read(f,limit)
 finally: os.close(f)
def identity():
 v=json.loads(read('status.json',65536))
 assert all(v.get(k)==x for k,x in expected.items()), 'Operation identity mismatch'
identity()
output=read({},{},{})
identity()
print(output.decode('utf-8','replace'))
os.close(fd)"#,
        serde_json::to_string(&binding.operation).expect("string"),
        serde_json::to_string(&json!({"operationId":binding.operation,"environmentId":binding.environment,"releaseId":binding.release})).expect("fixed identity"),
        serde_json::to_string(file).expect("fixed source"), limit, if private { "True" } else { "False" });
    let mut args = Vec::new();
    if private {
        args.extend(["sudo".into(), "--".into()]);
    }
    args.extend([
        "/usr/bin/python3".into(),
        "-I".into(),
        "-B".into(),
        "-S".into(),
        "-c".into(),
        script,
    ]);
    command(&args)
}
impl Setup {
    pub(super) fn diagnostic_guide(&self, id: &str) -> Result<Guide, String> {
        let entry = self.entry(id)?;
        if entry.id != id {
            return Err("Setup journal identity mismatch".into());
        }
        let binding = Binding::from_entry(&entry)?;
        if entry
            .target
            .identity_file
            .as_ref()
            .is_some_and(|path| path.chars().any(char::is_control) || text::sanitize(path) != *path)
        {
            return Err(
                "The saved SSH key path cannot be safely displayed in a diagnostic guide".into(),
            );
        }
        // Unlike a collection, a guide does not require a readable/unlocked identity file.
        let mut ssh = self.pinned_ssh_args(&entry).map_err(|_| {
            "The saved SSH host pin is unavailable; restore host trust before using a manual guide"
        })?;
        for arg in &mut ssh {
            if arg == "-T" {
                *arg = "-tt".into();
            }
        }
        ssh.insert(0, "/usr/bin/ssh".into());
        ssh.extend(["--".into(), entry.target.host.clone()]);
        let unit = format!("outpost-setup-{}.service", binding.operation);
        let mut steps = vec![
            Step { id: "connect".into(), title: "Open the pinned SSH session on this Mac".into(), command: command(&ssh), detail: format!("Independently compare the saved fingerprint {} with the server administrator. This uses the actual saved host, port, user, key/agent and private known-hosts file, with strict host checking and no forwarding. Unlock the SSH key/agent first; password SSH login is not enabled. A host-key mismatch is a stop condition, not a reason to disable verification. Run all following commands inside this interactive session.", entry.fingerprint), privileged: false, run_on: "mac" },
            Step { id: "receipt".into(), title: "Read this operation's receipt".into(), command: read_command(&binding, "status.json", 65536, false), detail: "Reads at most 64 KiB from the exact status.json after checking root ownership, permissions, regular-file type, no symlinks and operation/environment/release identity. Inspect state, stage, completedSteps, totalSteps, updatedAt (Unix milliseconds) and error. This is newly read evidence; the app's saved receipt may be older. Missing, unsafe or mismatched receipts require administrator review, not a new operation ID.".into(), privileged: false, run_on: "server" },
            Step { id: "command-log".into(), title: "Read the latest installer output".into(), command: read_command(&binding, "command.log", 12288, true), detail: "Sudo authorizes only a read of the exact operation's root-private command.log. The bounded 12 KiB tail may start mid-line and is not sanitized in your terminal: review before sharing. Legacy files contain the latest command's output, not guaranteed failed-command output or all history. A missing log does not prove success. Permission/unsafe-path errors are not fixed by this command.".into(), privileged: true, run_on: "server" },
            Step { id: "launch-log".into(), title: "Read the service launch output".into(), command: read_command(&binding, "launch.log", 4096, true), detail: "Reads only the final 4 KiB of this operation's protected launch.log under sudo. This can explain why systemd did not launch the installer; it does not contain later commands. A missing file may mean launch never reached this point. Do not infer a successful installation from an empty tail.".into(), privileged: true, run_on: "server" },
            Step { id: "service".into(), title: "Check the exact setup service".into(), command: command(&["/usr/bin/systemctl".into(), "show".into(), "--no-pager".into(), "--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus".into(), "--".into(), unit]), detail: "Reads only fixed scalar properties of this operation's transient service. LoadState=not-found can mean the transient unit was already collected, not that nothing ran. Result and ExecMainStatus describe the service; an exit code of zero cannot override a failed installation receipt. This does not restart, stop or enable any service.".into(), privileged: false, run_on: "server" },
        ];
        let progress = entry.installation.as_ref().ok_or("No saved receipt")?;
        if progress.completed_steps <= 4 {
            steps.push(Step { id: "capacity".into(), title: "Check space for runtime and browser dependencies".into(), command: "/bin/df -h -- / /opt /var".into(), detail: "Check available filesystem space and whether the runtime/data volumes are full. Low free space is a possible prerequisite failure, not a proven cause. If space is low, ask the administrator to review storage; do not delete operation receipts or partial runtime directories.".into(), privileged: false, run_on: "server" });
            steps.push(Step { id: "python".into(), title: "Check the system Python version".into(), command: "/usr/bin/python3 --version".into(), detail: "The reviewed installer requires Python 3.12 or later on Ubuntu 24.04+. This checks only the interpreter version, not dependency or browser health. A version mismatch is evidence to discuss with the administrator, not authorization to install packages or repeat bootstrap.".into(), privileged: false, run_on: "server" });
        }
        steps.push(Step { id: "return".into(), title: "Return to Outpost and Check progress".into(), command: "exit".into(), detail: "Leave this SSH session, then use Check progress in the same setup. Correcting a prerequisite does not resume a stopped installation. In particular, stopped-at-4/12 has no authorized resume/reinstall path. Do not repeat bootstrap, change operation IDs, delete receipts or remove native directories to bypass guards. Collect and review a sanitized report for your administrator instead.".into(), privileged: false, run_on: "server" });
        Ok(Guide {
            destination: format!(
                "{}@{}:{}",
                entry.target.user, entry.target.host, entry.target.port
            ),
            fingerprint: entry.fingerprint,
            steps,
        })
    }
}
