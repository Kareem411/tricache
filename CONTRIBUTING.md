# Contributing to tricache

Thank you for your interest in contributing! Here's everything you need to get started.

## Development setup

```bash
git clone https://github.com/Kareem411/tricache.git
cd tricache
pnpm install
```

## Running tests

```bash
pnpm test          # run all tests once
pnpm test:watch    # watch mode
pnpm typecheck     # TypeScript type-check only
```

All 43 tests must pass before opening a PR.

## Running benchmarks

```bash
pnpm bench
```

If your change touches a hot path (L1 get/set, eviction, serialization), include before and after bench numbers in your PR description.

## Pull request guidelines

1. **Fork** the repo and create a feature branch from `master`
2. **Keep PRs focused** — one feature or fix per PR
3. **Tests required** — add tests for new behaviour; don't break existing ones
4. **No new dependencies** without prior discussion — tricache's only runtime deps are `ioredis` and `msgpackr`
5. **Commit messages** should be descriptive (conventional commits style preferred: `feat:`, `fix:`, `perf:`, `docs:`)

## Codebase overview

| File | Purpose |
|---|---|
| `src/cache-service.ts` | Public API — `CacheService`, namespace isolation, SWR, inflight map |
| `src/smart-memory-cache.ts` | L1 engine — adaptive eviction, Bloom filter, msgpackr serialization |
| `src/disk-tier.ts` | L1.5 NVMe spill layer |
| `src/encryption.ts` | AES-256-GCM / AES-128-GCM / AES-128-CTR / XOR |
| `src/types.ts` | Shared TypeScript types |
| `src/wasm/bloom-filter-wasm.ts` | WASM Bloom filter (562-byte binary, Base64-inlined) |
| `bench/benchmark.ts` | Microbenchmarks — run with `pnpm bench` |
| `tests/` | Vitest test suite |

## Reporting bugs

Open a [GitHub Issue](https://github.com/Kareem411/tricache/issues) with:
- Node.js version and OS
- A minimal reproduction
- Expected vs actual behaviour

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Releasing a new version

1. Bump the version in `package.json`
2. Commit: `git commit -m "chore: bump version to X.Y.Z"`
3. Tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin master --tags
   ```

The CI will automatically run tests, publish to npm, and create a GitHub Release with auto-generated release notes.
