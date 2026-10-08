# 0051. Code signing for the Windows executable

## Summary

The Windows executable in a signed release now carries a digital signature, so a GM can see who published it and that it was not changed afterwards. A maintainer signs it on a Windows machine with the project's code-signing certificate, and the checksum list is rebuilt from the signed file. The signature is checked on Windows before anything is published. The main alternative, making `update` check the signature before it replaces the program, is rejected below because it adds a process spawn or a hand-written verifier to the most sensitive path, for no gain over the checksum list `update` already trusts. The limit a GM will meet is that the certificate is new, so Windows SmartScreen may still warn on first run until the certificate builds reputation.

Status: accepted.

## 1. What changes

Only the release process and the documents. No program code changes.

- A maintainer signs `gm-scriptorium-win-x64.exe`, timestamped, on a Windows machine. The key needs a person present to approve each session with a code from their phone, so signing cannot be automated.
- `SHA256SUMS` is regenerated after signing, so the published checksum for the executable is the checksum of the signed file. Downloading the assets back and re-hashing them proves the published bytes match.
- Before anything is published, the signed file is checked on Windows (criterion C141 in `.agents/windows-verification.md`). That check covers the signature status, who signed, the certificate chain, the timestamp, and that the program still starts. A second part runs after publishing and covers the update path.
- Before the check, the build machine confirms the signed file is the unsigned file plus a signature: the same bytes, apart from the checksum field, the security directory entry and padding. That is a plain byte comparison and needs no extra package.
- Prereleases may still ship unsigned, as a choice for each release. Their notes say so, and the older SmartScreen guidance applies. Stable releases are always signed.
- The signature carries the publisher's name as the certificate gives it. Anyone can read it in the file's properties. The release checks that look for private terms are told to expect those hits in the signature block and to review them on each signed release.

## 2. Self-update keeps trusting SHA256SUMS

`update` downloads `SHA256SUMS` from the same release and checks the executable against it by file name. Because the list is rebuilt after signing, that check already covers the signed bytes. Nothing in the update path changes.

## Rejected alternatives

- **Check the Authenticode signature inside `update`, by starting PowerShell.** `Get-AuthenticodeSignature` is the natural tool, but it means a new exception to the one-process-spawner rule (ADR 0046) and the test that pins it. It would also have to cope with prereleases that ship unsigned, and the Linux binary has no equivalent, so the two platforms would verify differently.
- **Check the signature inside `update`, with a verifier written in JavaScript.** Parsing a PKCS#7 signature, building a chain and checking a timestamp by hand is a large amount of new security-sensitive code in the one place that replaces the running program. A mistake there is worse than not checking, because it looks like a check.
- **Sign on a build server or in CI.** Not possible. The signing key sits behind a login that needs a code from the maintainer's phone for each session, so it cannot be handed to an unattended job. Putting the key where a job can reach it would defeat the point of the arrangement.
- **Install `osslsigncode` on the build machine to verify the signature early.** It would catch a bad signature without starting a Windows machine, but it adds a package to the build machine and is still not Windows' own verdict. The test that matters is what Windows says about the real file, so the Windows check is the authority and the extra package is skipped.
- **Write an Authenticode verifier in node for the build machine.** It needs no install, but it is a large amount of cryptographic code to get right, and it gives less than the Windows check it would sit in front of. The byte comparison in section 1 is the only check done on the build machine.

## Limits

- **Self-updated programs carry no Mark-of-the-Web.** Windows tags files that arrive through a browser, and SmartScreen only prompts for tagged files. `update` downloads through `gh`, so the new program is not tagged and SmartScreen does not prompt on that path. That is expected, and it means the checksum list, not SmartScreen, is what protects an update.
- **A new certificate draws reputation warnings.** SmartScreen trusts a certificate more as more people run programs signed with it. Until then, a first run of a downloaded executable may still show "Windows protected your PC", even though the signature is valid. The install guide says to click More info, then Run anyway. If Smart App Control is on and does not trust the certificate yet, it may block the program.
- **Signatures stay valid after the certificate expires.** Every signature is timestamped, so Windows judges it as of the time of signing. A release signed in time stays valid. Releases are never changed after publishing, so they are never re-signed. Signing a new release after the certificate expires needs a renewed certificate.

## Windows verification

How Windows treats the signature, the chain, the timestamp and the program's start-up is verified only from the real signed exe. It is OPEN: `.agents/windows-verification.md` C141. The checks on the build machine prove the file is the unsigned file plus a signature. They do not prove the signature is good.
