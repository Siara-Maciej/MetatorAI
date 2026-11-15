# @metator/plugin-git

`Vcs` and `RevisionReader` on simple-git; `WorkingTree` (`GitWorkingTree`) on the git CLI through the `ProcessRunner`.

- Tests create real repositories in a temp directory; never mock git.
- Pitfall: A repository without commits is valid: every method answers it without an error.
