# Release Checklist

## Before tagging

- [ ] Version is bumped in `package.json`.
- [ ] `CHANGELOG.md` has the new version and date.
- [ ] README installation instructions match the actual package layout.
- [ ] `LICENSE` exists.
- [ ] `npm run format:check` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm test` passes.
- [ ] `npm run smoke:load` passes.
- [ ] Manual Pi `/reload` test passes.
- [ ] Old duplicate local extensions are not included in packaged output.
- [ ] `npm run pack:check` output contains only intended files.
- [ ] Package metadata under the `pi` key points at `./src/index.ts`.

## Manual QA

- [ ] Fresh install works.
- [ ] `/reload` works.
- [ ] First render appears immediately.
- [ ] Phrase shuffles.
- [ ] Shine animates.
- [ ] Spinner is colored.
- [ ] Defaults restore after agent completes.
- [ ] Session shutdown does not leave timers running.

## Publishing

- [ ] Create a git tag for the version.
- [ ] Push the tag.
- [ ] Create GitHub release notes summarizing user-facing changes.
- [ ] If publishing to npm, verify `npm pack --dry-run` first.
