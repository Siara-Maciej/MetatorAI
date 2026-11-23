//! The loopback forwarder (ADR-0106): the window talks to `http://127.0.0.1:<port>` on this
//! computer, and each connection is joined to a fresh `docker exec -i <container> <metator>
//! tunnel --port <daemon's>` (the command `metator devcontainer serve` answered), which reaches the
//! daemon on 127.0.0.1 inside the container. HTTP and WebSockets are bytes both ways; nothing is
//! published from the container and VS Code is not needed. The command can be pointed elsewhere
//! (a rebuilt container, a restarted daemon) while the port stays the window's.

use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::process::{Child, ChildStdin, ChildStdout};
use std::sync::{Arc, Mutex};
use std::thread;

/// Starts the program a connection is joined to, its stdin and stdout piped.
pub type Spawn = Arc<dyn Fn(&[String]) -> io::Result<Child> + Send + Sync>;

/// The programs the app runs for its connections: the engine's CLI (an absolute path), without a
/// console window on Windows, stdin and stdout piped, stderr dropped.
pub fn processes() -> Spawn {
    Arc::new(|argv: &[String]| {
        let Some((program, args)) = argv.split_first() else {
            return Err(io::Error::other("no tunnel command"));
        };
        let mut c = std::process::Command::new(program);
        c.args(args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            c.creation_flags(0x0800_0000);
        }
        c.spawn()
    })
}

pub struct Forwarder {
    port: u16,
    target: Arc<Mutex<Vec<String>>>,
}

impl Forwarder {
    /// Listens on a free loopback port; every connection runs `argv` (as it is when it comes).
    pub fn start(argv: Vec<String>, spawn: Spawn) -> io::Result<Forwarder> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let port = listener.local_addr()?.port();
        let target = Arc::new(Mutex::new(argv));
        let shared = target.clone();
        thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(conn) = conn else { continue };
                let argv = shared.lock().map(|a| a.clone()).unwrap_or_default();
                let spawn = spawn.clone();
                thread::spawn(move || join(conn, &argv, &spawn));
            }
        });
        Ok(Forwarder { port, target })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The command new connections run from now on.
    pub fn point(&self, argv: Vec<String>) {
        if let Ok(mut t) = self.target.lock() {
            *t = argv;
        }
    }
}

/// One connection joined to one tunnel: what the window sends goes to the program's stdin (its end
/// closes stdin), what the program writes goes back; when the program ends, so does the connection.
fn join(conn: TcpStream, argv: &[String], spawn: &Spawn) {
    let _ = conn.set_nodelay(true);
    let Ok(mut child) = spawn(argv) else {
        let _ = conn.shutdown(Shutdown::Both);
        return;
    };
    let (Some(stdin), Some(stdout)) = (child.stdin.take(), child.stdout.take()) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let Ok(from_window) = conn.try_clone() else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    let up = thread::spawn(move || upstream(from_window, stdin));
    downstream(stdout, &conn);
    let _ = conn.shutdown(Shutdown::Both);
    let _ = child.kill();
    let _ = child.wait();
    let _ = up.join();
}

fn upstream(mut from: TcpStream, mut to: ChildStdin) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&buf[..n]).and_then(|_| to.flush()).is_err() {
                    break;
                }
            }
        }
    }
    // Dropping stdin tells the tunnel the window is done.
}

fn downstream(mut from: ChildStdout, mut to: &TcpStream) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if to.write_all(&buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::process::Command;
    use std::time::Duration;

    /// A daemon stand-in: answers each line `ping <n>` with `<name> pong <n>` on the same connection.
    fn daemon(name: &'static str) -> u16 {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            for c in l.incoming().flatten() {
                thread::spawn(move || {
                    let mut w = c.try_clone().unwrap();
                    for line in BufReader::new(c).lines().map_while(Result::ok) {
                        let n = line.trim_start_matches("ping ");
                        if w.write_all(format!("{name} pong {n}\n").as_bytes())
                            .is_err()
                        {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    /// The real `metator tunnel` of this checkout, run by bun (as the container runs its own).
    fn tunnel_argv(port: u16) -> Option<Vec<String>> {
        let main = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../cli/src/main.ts");
        let bun = Command::new("bun").arg("--version").output().ok()?;
        if !bun.status.success() || !main.exists() {
            return None;
        }
        Some(vec![
            "bun".to_string(),
            main.to_string_lossy().to_string(),
            "tunnel".to_string(),
            "--port".to_string(),
            port.to_string(),
        ])
    }

    fn talk(port: u16, n: usize) -> Vec<String> {
        let c = TcpStream::connect(("127.0.0.1", port)).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(20))).unwrap();
        let mut w = c.try_clone().unwrap();
        let mut r = BufReader::new(c);
        (0..n)
            .map(|i| {
                w.write_all(format!("ping {i}\n").as_bytes()).unwrap();
                let mut line = String::new();
                r.read_line(&mut line).unwrap();
                line.trim().to_string()
            })
            .collect()
    }

    #[test]
    fn each_connection_is_its_own_tunnel_both_ways_and_new_ones_follow_the_new_target() {
        let first = daemon("first");
        let Some(argv) = tunnel_argv(first) else {
            eprintln!("skipped: bun is not on PATH");
            return;
        };
        let f = Forwarder::start(argv, processes()).unwrap();
        // Two long-lived connections at once (as a WebSocket and a request are), each answered on its own.
        let a = thread::spawn({
            let p = f.port();
            move || talk(p, 3)
        });
        let b = talk(f.port(), 2);
        assert_eq!(b, ["first pong 0", "first pong 1"]);
        assert_eq!(
            a.join().unwrap(),
            ["first pong 0", "first pong 1", "first pong 2"]
        );
        // A rebuilt container or a restarted daemon: the window's port stays, the target moves.
        let second = daemon("second");
        f.point(tunnel_argv(second).unwrap());
        assert_eq!(talk(f.port(), 1), ["second pong 0"]);
    }

    #[test]
    fn a_tunnel_that_cannot_start_or_ends_closes_the_connection() {
        let gone: Spawn = Arc::new(|_: &[String]| Err(io::Error::other("no docker")));
        let f = Forwarder::start(vec!["docker".to_string()], gone).unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", f.port())).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut buf = [0u8; 8];
        assert_eq!(c.read(&mut buf).unwrap_or(0), 0);

        // A container that stopped: its exec ends at once, and so does the connection.
        let ends = Forwarder::start(
            vec!["sh".to_string(), "-c".to_string(), "exit 1".to_string()],
            processes(),
        )
        .unwrap();
        let mut c = TcpStream::connect(("127.0.0.1", ends.port())).unwrap();
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let _ = c.write_all(b"GET / HTTP/1.1\r\n\r\n");
        assert_eq!(c.read(&mut buf).unwrap_or(0), 0);
    }
}
