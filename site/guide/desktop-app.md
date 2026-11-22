# Get the desktop app

The desktop app is a window over the daemon, `metator serve`. It needs the [`metator` command](./install.md) and a daemon running in your repository or folder. There are three ways to get it.

## An installer

The MetatorAI repository builds the installers in its `desktop` workflow (GitHub Actions), for every change to the app:

| Platform | Artifact | Files |
|---|---|---|
| Windows | `metatorai-desktop-windows-x64` | `.exe`, `.msi` |
| macOS (Apple Silicon and Intel) | `metatorai-desktop-macos-universal` | `.dmg` |
| Linux | `metatorai-desktop-linux-x64` | `.deb`, `.AppImage` |

Open the repository's **Actions** tab, the latest run of **desktop**, and download the artifact under **Artifacts**. A tag `desktop-v*` also puts every installer on a GitHub Release, made as a draft pre-release for a maintainer to publish.

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
