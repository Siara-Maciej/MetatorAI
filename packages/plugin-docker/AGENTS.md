# @metator/plugin-docker

`ContainerRuntime` on the Docker CLI (`docker compose`) for `env up|down|logs` (ADR-0053). MVP: Docker only.

- One Compose project per repository and place (`metator-<repo>-<tag>-<place>`, ADR-0056), so neither worktrees nor repositories stop each other's containers.
- Pitfall: Compose reads ports from the environment only where the compose file says so (`"${METATOR_PORT_API_HTTP:-3000}:3000"`); fixed ports in the file collide across worktrees.
