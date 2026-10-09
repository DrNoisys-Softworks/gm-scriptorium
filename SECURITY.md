# Security policy

## Reporting a vulnerability

Please report security vulnerabilities through GitHub's private vulnerability
reporting: open the **Security** tab on this repository and choose **Report a
vulnerability**. Do not open a public issue for a security report.

## Supported versions

Only the newest release is supported, and until 1.0 that includes
prereleases. Please upgrade before reporting an issue that may already be
fixed.

## Scope

In scope:

- the CLI (`init`, `check`, `build`, `serve`, `status`, `config`, `remote`, `update`)
- the admin panel (`serve --admin`)
- remote access to the admin panel (the `remote` command and the panel's
  Remote access screen)
- launch mode (running the program with no command, which opens the panel)
- the update mechanism
- the build pipeline and its leak checks

Out of scope: the vendored `gm-apprentice-publish` generator itself. Report
issues in the generator to its own repository.
