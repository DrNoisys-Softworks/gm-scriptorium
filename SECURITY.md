# Security policy

## Reporting a vulnerability

Please report security vulnerabilities through GitHub's private vulnerability
reporting: open the **Security** tab on this repository and choose **Report a
vulnerability**. Do not open a public issue for a security report.

## Supported versions

Only the latest release is supported. Please upgrade before reporting an
issue that may already be fixed.

## Scope

In scope:

- the CLI (`init`, `check`, `build`, `serve`, `status`, `config`, `update`)
- the admin panel (`serve --admin`)
- the update mechanism
- the build pipeline and its leak checks

Out of scope: the vendored `gm-apprentice-publish` generator itself. Report
issues in the generator to its own repository.
