# Dev Containers

Your repository lives in a dev container (VS Code's Dev Containers extension, or the `devcontainer` CLI) and the app runs on Windows or macOS. Add the repository from the container: everything MetatorAI starts runs in the container (the daemon, git, the hooks, Claude Code or Copilot CLI sessions), as the container's user and with its environment. The app on your computer only shows the window. VS Code does not have to be open.

## What you need

- **Docker Desktop**, or **Rancher Desktop** with either engine (dockerd/moby or containerd). The app uses the `docker` command when its engine answers, else `nerdctl`, with the docker context that is current. It needs nothing else: no SDK, no published port.
- **The dev container, made once**: open the folder in VS Code (**Reopen in Container**) or run `devcontainer up`. The app finds it by the labels those tools put on it; it does not make a container that does not exist. A stopped container can be started from the app.
- **A glibc image on x86_64 or arm64**: Debian 11, Ubuntu 20.04 or newer (the `mcr.microsoft.com/devcontainers/*` images are), with `tar` and `gzip`. Alpine (musl) is not supported.
- **git and Claude Code or GitHub Copilot CLI in the container**, logged in there. The app checks them in the container and says how to add what is missing (below).

## Add a repository from a dev container

1. **Add repository…**, then the source **Dev Container**. The app lists the dev containers it found: the local folder's name, running or stopped, and the workspace folder inside. **Start** starts a stopped one.
2. Choose one. The first time, and after each update of the app, the app copies MetatorAI's Linux CLI into the container: into `~/.metator/server/<version>/` of the container's user, the way VS Code installs its server. It takes a few seconds (about 57 MB) and is not repeated while that version is there. Nothing else in the container changes: not your `PATH`, not your files.
3. From here it is the usual flow, run in the container: the app looks at the workspace folder (`metator inspect`), offers **Set up** with the host of your choice, then **Commit** the files setup wrote. See [Get the desktop app](./desktop-app.md#add-a-repository).
4. The app remembers the repository, starts its daemon in the container and opens it. The repository switcher shows it as **shop (Dev Container)**.

The app knows the repository by the container's local folder (the `devcontainer.local_folder` label), so it survives a **Rebuild Container**: the new container is found again on the next connect.

## How the window reaches the container

The daemon listens on `127.0.0.1` inside the container, as it does on your computer. The app opens a port on your computer's loopback and, for each connection of its window, runs `docker exec -i <container> metator tunnel --port <the daemon's port>`, which joins the connection to the daemon inside. HTTP and the terminals' WebSockets go through it. No port is published from the container and nothing listens on your network.

When the container stops, the window says **The container stopped**, with **Start** and **Reconnect**.

## Claude Code, Copilot CLI and git in the container

The AI host must be installed and logged in **in the container**, where it runs. When one is missing, the app says how to add it there:

| Tool | In `devcontainer.json` (then Rebuild Container) | Or in the container's terminal |
|---|---|---|
| Claude Code | `"ghcr.io/anthropics/devcontainer-features/claude-code:1": {}` under `features` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| GitHub Copilot CLI | Node 22 or newer (`"ghcr.io/devcontainers/features/node:1": {}`) | `npm install -g @github/copilot` |
| git | `"ghcr.io/devcontainers/features/git:1": {}` | `sudo apt-get update && sudo apt-get install -y git` |

Log in once in the container's terminal (`claude`, then `/login`; `copilot`, then `/login`). A login made on Windows does not reach the container.

## Open in the editor

For a repository in a dev container, **Open in editor** opens VS Code on your computer, attached to the container, at the file and line: `vscode://vscode-remote/dev-container+<hex>/<path in the container>:<line>`. This is the link the Dev Containers extension itself uses. No editor is started in the container.

## From a terminal

The same commands the app runs work in a terminal on your computer, with the `metator` command installed ([Install](./install.md#the-metator-command-in-your-terminal)):

```bash
metator devcontainer list                                  # the dev containers docker or nerdctl knows
metator devcontainer start shop                            # by the folder's name, the local folder, or the container's name or id
metator devcontainer install shop                          # the Linux CLI into ~/.metator/server/<version>/
metator devcontainer run shop -- inspect . --json          # metator in the container, in the workspace folder
metator devcontainer exec shop -- git status               # any program, as the container's user
metator devcontainer serve shop                            # the daemon there, and the tunnel command to reach it
```

`--bundles <dir>` (or `METATOR_LINUX_BUNDLES`) names the Linux CLI bundles when the `metator` you run is not the app's (a checkout, npm, the Linux app). `--env NAME=value` adds a variable for the program in the container.

## When something is off

- **No container engine found**: Docker Desktop or Rancher Desktop is not running, or neither `docker` nor `nerdctl` is on your `PATH`. Start it, then **Refresh**.
- **No dev container yet**: open the folder once in VS Code (**Reopen in Container**), or run `devcontainer up`.
- **Alpine-based (musl)**: use a Debian or Ubuntu based image for the dev container.
- **glibc too old** or **another architecture**: use a newer image on x86_64 or arm64.
- **Wrong user**: the app runs as `remoteUser` from your `devcontainer.json`, else `containerUser`, else the image's user.
- Old versions of the CLI stay in `~/.metator/server/` until you remove them (`rm -rf ~/.metator/server/<version>`).

## Check it on your computer

A checklist for a first try, with each engine. For each one: a dev container of a small repository, made once with VS Code (**Reopen in Container**), then VS Code closed.

**Windows, Docker Desktop (WSL 2)**

1. `docker context show` in PowerShell says `desktop-linux` (or `default`); `docker ps` lists the dev container.
2. The app: **Add repository…**, **Dev Container**: the container is listed with its folder's name, **running**, and a workspace folder (`/workspaces/<name>`).
3. Stop it (`docker stop <name>`), **Refresh**: it says **stopped**; **Start** starts it.
4. Choose it: the install says it copies MetatorAI into the container, then the inspection shows git, Claude Code and Copilot CLI as found in the container, with the feature lines for what is missing.
5. **Set up**, **Commit**: `git log -1` in the container's terminal shows "Set up MetatorAI" by the container's user.
6. The repository opens; the switcher says **(Dev Container)**. **+ New chat** starts Claude Code in the container (`ps -ef` in the container shows it as the container's user; Task Manager on Windows shows no `claude`).
7. A terminal pane types and answers; **Open in editor** opens VS Code attached to the container at the file.
8. `docker stop <name>`: the window says **The container stopped**; **Start**, then the window comes back.
9. **Rebuild Container** in VS Code, close VS Code, **Reconnect** in the app: the repository opens again (the new container, the same entry).

**Windows, Rancher Desktop, dockerd (moby)**: the same steps; `docker context show` says `rancher-desktop`.

**Windows, Rancher Desktop, containerd**: the same steps with `nerdctl` (`nerdctl ps -a` lists the container; `docker` must not answer, or be absent). Make the container with `devcontainer up --docker-path nerdctl --workspace-folder .`, or with VS Code's `dev.containers.dockerPath` set to `nerdctl`. The app's list says it found the containers through nerdctl.

On macOS, the same steps with Docker Desktop or Rancher Desktop.
