# @metator/plugin-docker

`ContainerRuntime` on the Docker CLI (`docker compose`) for `env up|down|logs` (ADR-0053), each command one process through the `ProcessRunner` port. MVP: Docker only.

`ContainerEngine` for Dev Containers (ADR-0106): `DockerCliEngine` and `NerdctlCliEngine` on the CLI the person has, never an SDK or the engine's socket. Both run `containerEngineContract` on `standInContainerCli` (`@metator/testing`); a change to what they ask of the CLI is a change of the stand-in too.

- One Compose project per repository and place (`metator-<repo>-<tag>-<place>`, ADR-0056), so neither worktrees nor repositories stop each other's containers.
- Pitfall: `nerdctl cp` does not read a tar from stdin and `docker cp` makes root's files; a file goes in through `exec -i … cat`, as the container's user.
- Pitfall: Compose reads ports from the environment only where the compose file says so (`"${METATOR_PORT_API_HTTP:-3000}:3000"`); fixed ports in the file collide across worktrees.
