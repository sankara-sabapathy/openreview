# Versioning

- Action SemVer: `v0.17.0` + mutable `v0`/`v1` tags, both moved to every release by `release.yml`. Pin `@v1` for latest, `@v0.17.0` to freeze.
- Config `version: 1` (schema version, required; additive-only in v1.x). Breaking changes bump to `version: 2` with migration guide.
- Optional `requires_action: ">=0.3.0"` sets a floor for the running action release and fails fast with a clear message. The workflow `uses:` ref selects the release — the yaml cannot pin it, only guard it. The running version resolves from the exact tag ref, else the action's own `package.json` (so floating `@v1` pins gate correctly); unknown versions skip the check rather than blocking.
- Docs versioned per major via Docusaurus.
- Releases: Conventional Commits → release-please → GitHub Release → tag move.
