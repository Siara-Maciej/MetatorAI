//! The app's loopback forwarder alone, for a proof against a real container (ADR-0106):
//! `cargo run --example forward -- <program> <args…>` prints the port, then joins each
//! connection to that command until its stdin closes.
use metator_desktop_lib::forward::{processes, Forwarder};
use std::io::Read;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let f = Forwarder::start(argv, processes()).expect("listen on 127.0.0.1");
    println!("{}", f.port());
    let mut rest = String::new();
    let _ = std::io::stdin().read_to_string(&mut rest);
}
