#!/usr/bin/env bash
# Regenerates every file in this directory with the openssl CLI (independent of src/cert).
# TEST-ONLY keys and certificates. Never trust any of them anywhere. Only RFC 5737 and
# RFC 6761/6762-style example names are used. Run from anywhere: bash regenerate.sh
set -euo pipefail
cd "$(dirname "$0")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SAN_VALID='subjectAltName=DNS:scriptorium.home.arpa,DNS:preview.scriptorium.home.arpa,IP:192.0.2.42,DNS:localhost,IP:127.0.0.1'
SAN_WRONG='subjectAltName=DNS:scriptorium.home.arpa.example,IP:192.0.2.43'
LEAF_EXT='basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=serverAuth'

# --- CA (EC P-256, 20 years) and intermediate (EC P-256, 20 years, pathlen 0)
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 7300 -subj '/O=Test Fixture CA (test-only, never trust)/CN=fixture root' \
  -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -out ca.pem

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out intermediate.key
openssl req -new -key intermediate.key -subj '/O=Test Fixture CA (test-only, never trust)/CN=fixture intermediate' -out "$WORK/int.csr"
printf 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$WORK/int.ext"
openssl x509 -req -in "$WORK/int.csr" -CA ca.pem -CAkey ca.key -CAcreateserial -CAserial "$WORK/ca.srl" -sha256 -days 7300 -extfile "$WORK/int.ext" -out intermediate.pem

sign_leaf() { # name issuerPem issuerKey san days
  openssl req -new -key "$1.key" -subj '/O=Test Fixture (test-only)' -out "$WORK/$1.csr"
  printf '%s\n%s\n' "$LEAF_EXT" "$5" > "$WORK/$1.ext"
  openssl x509 -req -in "$WORK/$1.csr" -CA "$2" -CAkey "$3" -CAcreateserial -CAserial "$WORK/$1.srl" -sha256 -days "$4" -extfile "$WORK/$1.ext" -out "$1.pem"
}

# --- leaves, 10 years
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ec-leaf.key
sign_leaf ec-leaf ca.pem ca.key 3650 "$SAN_VALID"

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out rsa-leaf.key
sign_leaf rsa-leaf ca.pem ca.key 3650 "$SAN_VALID"

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out chain-leaf.key
sign_leaf chain-leaf intermediate.pem intermediate.key 3650 "$SAN_VALID"
cat chain-leaf.pem intermediate.pem > "$WORK/chain.pem" && mv "$WORK/chain.pem" chain-leaf.pem

openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out wrong-san-leaf.key
sign_leaf wrong-san-leaf ca.pem ca.key 3650 "$SAN_WRONG"

# --- a key that matches no certificate, and a really encrypted key (passphrase is public, test-only)
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out mismatch.key
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -aes-256-cbc -pass pass:test-only-passphrase -out encrypted.key

# --- expired leaf: 2020-01-01 to 2020-02-01, via `openssl ca` with a minimal config
mkdir -p "$WORK/ca/new"
: > "$WORK/ca/index.txt"
echo 1000 > "$WORK/ca/serial"
cat > "$WORK/ca.cnf" <<CNF
[ ca ]
default_ca = CA_default
[ CA_default ]
dir = $WORK/ca
database = \$dir/index.txt
new_certs_dir = \$dir/new
serial = \$dir/serial
default_md = sha256
policy = policy_any
unique_subject = no
copy_extensions = none
[ policy_any ]
organizationName = optional
[ leaf_ext ]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature
extendedKeyUsage = serverAuth
$SAN_VALID
CNF
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out expired-leaf.key
openssl req -new -key expired-leaf.key -subj '/O=Test Fixture (test-only)' -out "$WORK/expired.csr"
openssl ca -batch -config "$WORK/ca.cnf" -cert ca.pem -keyfile ca.key -in "$WORK/expired.csr" \
  -startdate 20200101000000Z -enddate 20200201000000Z -extensions leaf_ext -notext -out expired-leaf.pem
echo "regenerated"
