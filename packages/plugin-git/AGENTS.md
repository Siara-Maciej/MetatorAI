# @metator/plugin-git

`Vcs` and `RevisionReader` on simple-git.

- Tests create real repositories in a temp directory; never mock git.
- Pitfall: A repository without commits is valid: every method answers it without an error.
