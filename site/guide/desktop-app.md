# Get the desktop app

The desktop app is all you install: the `metator` command is inside it, and the app starts the daemon (`metator serve`) of each repository itself. Besides the app you need git and Claude Code or GitHub Copilot CLI ([Requirements](./install.md#requirements)). Working in the terminal only, without a window? [Install](./install.md) has that way too: choose **Terminal only** there.

## An installer

Download it from the repository's [Releases](https://github.com/Siara-Maciej/MetatorAI/releases):

- **[MetatorAI Desktop (latest build of main)](https://github.com/Siara-Maciej/MetatorAI/releases/tag/desktop-latest)**: rebuilt and replaced on every change to the app on main, marked as a pre-release;
- **MetatorAI Desktop &lt;version&gt;**: a release for every `desktop-v*` tag.

| Platform | Files |
|---|---|
| Windows | `.exe` (installer), `.msi` |
| macOS, Apple Silicon and Intel | `.dmg` |
| Linux | `.deb`, `.AppImage` |

The installers are not signed yet. Windows SmartScreen asks once (**More info**, then **Run anyway**). On macOS, the first start ends with "MetatorAI Not Opened": click **Done**, then open **System Settings**, **Privacy & Security**, and click **Open Anyway** next to MetatorAI (or run `xattr -dr com.apple.quarantine /Applications/MetatorAI.app`); before macOS 15, right-click the app and choose **Open**. On Linux, make the `.AppImage` executable (`chmod +x`).

The same files are kept on every run of the `desktop` workflow, pull requests included: the repository's **Actions** tab, the run, **Artifacts**.

## Add a repository

The first time, the app has no repository and shows **Welcome to MetatorAI**, with what MetatorAI needs on this computer and **Add repository**. Later, **Add repository…** is in the repository switcher of the top bar, and in **Settings**.

1. **Choose folder…** opens your system's folder picker; you can also type the path.
2. The app looks at the folder (`metator inspect`, which writes nothing) and says what it found:
   - **not a git repository**: it offers `git init`, which runs only when you click it;
   - **already set up**: it adds the repository and opens it; nothing is set up again;
   - **not set up**: it lists the files setup will write and lets you choose the AI host (the first one installed is chosen). **Set up** runs `metator setup` with its output on the screen;
   - **a folder of repositories**: it offers setup for each repository not set up yet, then adds the folder.
3. After setup: **Setup wrote N files. Commit them?** **Commit** commits exactly those files with the message “Set up MetatorAI”; your other changes stay out of it. **Not now** leaves them uncommitted: a commit is always your decision.
4. The app remembers the repository, starts its daemon and opens it.

Is the repository in a dev container (VS Code's Dev Containers)? Choose the source **Dev Container** instead: the same flow runs in the container, and so does everything after it ([Dev Containers](./devcontainers.md)).

A worktree of a repository the app knows opens that repository. **Remove from the app** (in **Settings**, **Repositories**) forgets a repository; its files stay.

When git or the AI host is missing, or the host is installed but not logged in, the app says what to install or type, with a link and **Retry**. When a repository was set up by a newer MetatorAI than the app's, the app asks you to update the app.

## Settings

- **The metator command**, **Where it comes from**: **Bundled with the app** (the default), **The metator on your PATH**, or **A metator you chose**. The other two are for developers who run MetatorAI from a checkout.
- **Install the metator command**: puts `metator` on your terminal's `PATH`, only when you click it ([Install](./install.md#install-metatorai)).
- **Repositories**: the repositories and folders the app knows, each with **Open** and **Remove from the app**.

Everything the app starts (the daemon, and through it every agent's session and the hooks in it) finds the app's `metator` first on its `PATH`, so the hooks your repository commits keep calling plain `metator`.

## From a checkout

With [Rust](https://www.rust-lang.org/tools/install) and your platform's webview libraries (on Linux, WebKitGTK), run the window from your checkout of MetatorAI:

```bash
cd ~/tools/metatorai/packages/desktop
bun run tauri dev
```

A window run this way has no bundled `metator`: it runs the one on your `PATH` ([From a checkout](./install.md#from-a-checkout-for-developers-of-metatorai)), or the program named by `METATOR_BIN`.

## In a browser

The app is also a web page. Without Rust, serve it and open it in a browser:

```bash
cd ~/tools/metatorai/packages/desktop
bun run dev          # http://localhost:1420
```

A browser cannot pick a folder or start a program. Its **Add repository** shows the path field and the commands to run in a terminal instead, and says that the desktop app does it for you:

```bash
cd /path/to/your/repository
metator inspect .
metator setup --host claude --yes
metator setup --commit --files <the files setup listed>
metator serve
```

A browser shows the app's notifications once you allow them for the page.

## Connect it to the daemon

The desktop app starts the daemon of the repository it opens. In a browser, the app looks for the daemon at `http://127.0.0.1:4310`, the default address of `metator serve`. The word on the right of the top bar reads **connected** when it found it, and **no daemon** when nothing answers. Then the main area shows the command to start one, a field with the address, and **Retry**: type another address there when your daemon listens elsewhere (`metator serve --port <n>`), and the app remembers it. It also tries again by itself every two seconds. It reads **not answering** when the daemon holds the connection but does not answer (a stopped or stuck process); the screens then keep what they showed under **Not up to date: no answer since …** ([Troubleshooting](../reference/troubleshooting.md#the-app-says-not-answering)).

In a browser, `?daemon=<url>` in the address names the daemon for that page.

## The Linux CLI for Dev Containers

The Windows and macOS installers also carry the `metator` command for Linux (x64 and arm64, for distributions with glibc). The app copies it into a dev container when you add a repository from one ([Dev Containers](./devcontainers.md)).

Next: [Start with one repository](./first-run.md) or [Start with many repositories](./many.md).
