# MetatorAI plugin for herdr

herdr runs the terminals; MetatorAI guards the agents in them (ADR-0079). See `site/guide/herdr.md`.

```bash
herdr plugin link "$(pwd)/integrations/herdr"
```

Actions (herdr's action menu, workspace context): attach, release, sync. Pane: the MetatorAI inbox (`metator ui`) as an overlay. Event hook: `pane.agent_status_changed` runs `metator herdr plugin sync`.
