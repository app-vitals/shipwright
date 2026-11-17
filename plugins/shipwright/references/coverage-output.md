# Coverage output contract

How a repository publishes its test coverage so Shipwright can read it. The
reader (`scripts/coverage-summary.ts`) never runs a repo's tests; it only
consumes what CI uploads. Skills reference this file instead of restating it.

## The contract

1. **Artifact name:** CI uploads a workflow artifact named exactly
   `shipwright-coverage`.
2. **Contents:** one or more coverage report files in an accepted format
   (below). The format is detected from file content, not file name, so any
   file name works, except the `shipwright-coverage.json` escape hatch.
3. **Runs on the default branch:** the CI workflow that uploads the artifact
   must run on pushes to the default branch. The reader only considers
   artifacts produced on the default branch, so a workflow that runs only on
   pull requests reports nothing and the repo shows as not reporting.
4. **Always upload:** upload even when tests fail (`if: always()`), and warn
   rather than fail when no report exists.

## Accepted formats

| Format | Typical producer | Detected by |
|--------|------------------|-------------|
| lcov | Bun, Jest, Vitest, Rust (`cargo llvm-cov`), Ruby (simplecov-lcov) | `TN:` / `SF:` records |
| Cobertura XML | Python (coverage.py), .NET (coverlet), PHPUnit | `<coverage>` root element |
| JaCoCo XML | Java / Kotlin (JaCoCo) | `<report>` root element |
| Go coverprofile | `go test -coverprofile` | leading `mode:` line |
| `shipwright-coverage.json` | anything else | the file name |

### JSON escape hatch

When a tool has no supported format, write a file named
`shipwright-coverage.json` into the artifact. Only raw counts are carried,
never percentages, so reports can be summed:

```json
{
  "tool": "my-tool",
  "lines": { "covered": 840, "total": 1000 },
  "branches": { "covered": 120, "total": 200 },
  "functions": { "covered": 90, "total": 100 }
}
```

`lines` is required. `branches`, `functions` and `tool` are optional.
`covered` and `total` must be integers with `0 <= covered <= total`; a file
that violates this is treated as invalid.

## Example upload step

```yaml
on:
  push:
    branches: [main]   # the default branch
  pull_request:

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # ... install dependencies and run tests with coverage enabled ...
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: shipwright-coverage
          path: coverage/lcov.info
          if-no-files-found: warn
```

Replace `path` with the report path from the recipe table.

## Per-language recipes

| Language / tool | Native reporter command | Report path |
|-----------------|-------------------------|-------------|
| JS/TS, Bun | `bun test --coverage --coverage-reporter=lcov` | `coverage/lcov.info` |
| JS/TS, Jest | `jest --coverage --coverageReporters=lcov` | `coverage/lcov.info` |
| JS/TS, Vitest | `vitest run --coverage --coverage.reporter=lcov` | `coverage/lcov.info` |
| Python | `coverage run -m pytest && coverage xml` | `coverage.xml` |
| Go | `go test -coverprofile=coverage.out ./...` | `coverage.out` |
| Rust | `cargo llvm-cov --lcov --output-path lcov.info` | `lcov.info` |
| Java / Kotlin | `./gradlew test jacocoTestReport` (or `mvn test jacoco:report`) | `build/reports/jacoco/test/jacocoTestReport.xml` (Maven: `target/site/jacoco/jacoco.xml`) |
| .NET | `dotnet test --collect:"XPlat Code Coverage"` (coverlet, Cobertura output) | `**/TestResults/*/coverage.cobertura.xml` |
| Ruby | `bundle exec rspec` with `simplecov-lcov` configured | `coverage/lcov/<name>.lcov` |
| PHP | `phpunit --coverage-cobertura coverage.xml` | `coverage.xml` |

Report paths vary with tool configuration; check the tool's output directory.
Multiple report files may be uploaded in one artifact and are summed.

## Raw total, no path excludes

The reader reports the raw total of the uploaded report and applies no path
excludes. A repo that wants files excluded (generated code, vendored
directories, test helpers) configures that in its coverage tool so the
exclusions are already reflected in the report. A repo whose own coverage
gate applies its own excludes before checking a threshold will therefore see
a reported figure that can differ from the gate's figure.
