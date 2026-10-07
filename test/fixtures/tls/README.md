# TLS test fixtures

**Throwaway, test-only keys and certificates. They are never used anywhere outside these tests, and
nothing should ever trust them.** Every private key in this directory is public by virtue of being
committed. They exist so `test/cert-*.test.js` can check the
certificate inspector against certificates made by something other than our own code (the `openssl`
CLI). Nothing in `src/` reads this directory.

Regenerate everything with `bash regenerate.sh` (needs `openssl` 3.x; verified with 3.0.22). The script
is the record of every command; the table says which command makes which file. Names and addresses are
reserved examples only: `*.home.arpa` (RFC 8375) and the RFC 5737 documentation addresses.

| File | How it is made (see `regenerate.sh`) |
|---|---|
| `ca.key`, `ca.pem` | `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256`, then `openssl req -x509 -days 7300` (CA:TRUE, keyCertSign). Valid 20 years from 2026-10-03 (to 2046-09-28). |
| `intermediate.key`, `intermediate.pem` | EC P-256 key, `openssl req -new`, signed by `ca` with `openssl x509 -req -days 7300`, CA:TRUE pathlen:0. Same 20 years. |
| `ec-leaf.key`, `ec-leaf.pem` | EC P-256 key, signed by `ca`, `-days 3650` (2026-10-03 to 2036-09-30). CA:FALSE, digitalSignature, serverAuth. |
| `rsa-leaf.key`, `rsa-leaf.pem` | As `ec-leaf` with an RSA 2048 key (`rsa_keygen_bits:2048`). |
| `chain-leaf.key`, `chain-leaf.pem` | As `ec-leaf` but signed by `intermediate`; the PEM holds the leaf then the intermediate. |
| `expired-leaf.key`, `expired-leaf.pem` | `openssl ca -batch -startdate 20200101000000Z -enddate 20200201000000Z` against a throwaway config, signed by `ca`. Valid 2020-01-01 to 2020-02-01. |
| `wrong-san-leaf.key`, `wrong-san-leaf.pem` | As `ec-leaf` but the only names are `scriptorium.home.arpa.example` and `192.0.2.43` (string-prefix siblings of the real ones). |
| `mismatch.key` | A fresh EC P-256 key that belongs to no certificate here. |
| `encrypted.key` | `openssl genpkey ... -aes-256-cbc -pass pass:test-only-passphrase`. Really encrypted (`openssl pkey -in encrypted.key -noout` asks for a passphrase). The passphrase is public and test-only. |

Valid leaves cover: `scriptorium.home.arpa`, `preview.scriptorium.home.arpa`, `192.0.2.42`,
`localhost`, `127.0.0.1`. Tests fix the clock at `2027-01-01T00:00:00Z`.
