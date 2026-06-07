# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest 0.x | Yes |
| Older releases | No |

Only the most recent release on the `0.x` line receives security fixes.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities via [GitHub private security advisories](https://github.com/app-vitals/shipwright/security/advisories/new). You'll receive a response within 7 days acknowledging receipt. We'll coordinate a fix and a disclosure timeline with you before any public announcement.

## Scope

Shipwright is a CLI plugin toolchain. Security issues in scope include:

- Code execution or privilege escalation via plugin commands or task execution.
- Credential or secret exposure through logging, error output, or generated artifacts.
- Unsafe handling of repository content that could be exploited by a malicious repo.
- Dependency vulnerabilities with a credible exploit path in Shipwright's use of that dependency.

Out of scope: issues in the underlying Claude Code platform, GitHub, or Anthropic's APIs — report those to the respective vendors.
