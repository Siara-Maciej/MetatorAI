# Get the desktop app

The desktop app is a window over the daemon, `metator serve`. It needs the [`metator` command](./install.md) and a daemon running in your repository or folder. There are three ways to get it.

## An installer

Download it from the repository's [Releases](https://github.com/Siara-Maciej/MetatorAI/releases):

- **[MetatorAI Desktop (latest build of main)](https://github.com/Siara-Maciej/MetatorAI/releases/tag/desktop-latest)**: rebuilt and replaced on every change to the app on main, marked as a pre-release;
- **MetatorAI Desktop &lt;version&gt;**: a release for every `desktop-v*` tag.

| Platform | Files |
|---|---|
| Windows | `.exe` (installer), `.msi` |
| macOS, Apple Silicon and Intel | `.dmg` |
| Linux | `.deb`, `.AppImage` |

The installers are not signed yet. Windows SmartScreen asks once (**More info**, then **Run anyway**). On macOS, open the app the first time with right-click, **Open**. On Linux, make the `.AppImage` executable (`chmod +x`).

The same files are kept on every run of the `desktop` workflow, pull requests included: the repository's **Actions** tab, the run, **Artifacts**.

## From a checkout

With [Rust](https://www.rust-lang.org/tools/install) and your platform's webview libraries (on Linux, WebKitGTK), run the window from your checkout of MetatorAI:

```bash
cd ~/tools/metatorai/packages/desktop
bun run tauri dev
```

## In a browser

The app is also a web page. Without Rust, serve it and open it in a browser:

```bash
cd ~/tools/metatorai/packages/desktop
bun run dev          # http://localhost:1420
```

A browser shows the app's notifications once you allow them for the page.

## Connect it to the daemon

The app looks for the daemon at `http://127.0.0.1:4310`, the default address of `metator serve`. The word on the right of the top bar reads **connected** when it found it, and **no daemon** when nothing answers. Then the main area shows the command to start one, a field with the address, and **Retry**: type another address there when your daemon listens elsewhere (`metator serve --port <n>`), and the app remembers it. It also tries again by itself every two seconds.

In a browser, `?daemon=<url>` in the address names the daemon for that page.

Next: [Start with one repository](./first-run.md) or [Start with many repositories](./many.md).
