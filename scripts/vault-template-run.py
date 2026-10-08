#!/usr/bin/env python3
"""Run gm-apprentice's vault scaffold once, with a fixed date, for scripts/vault-template.js.

    python3 -I vault-template-run.py CHECKOUT VAULT SYSTEM NAME DATE

CHECKOUT is a fresh clone of gm-apprentice at the pinned commit. VAULT is a new folder.
SYSTEM is a game system id, or "none". NAME is the campaign name. DATE is YYYY-MM-DD.

The scaffold takes the date from the clock, so this driver replaces the scaffold module's clock
with a fixed date and changes nothing else. A control run through the scaffold's own command line
(see capture in vault-template.js) proves that. Run it from a folder outside the checkout, with
-I so that nothing in the working directory or the environment is imported. Standard library only.
"""

import datetime
import os
import sys
import types


def main(argv):
    if len(argv) != 6:
        print(__doc__, file=sys.stderr)
        return 2
    _prog, checkout, vault, system, name, day = argv
    when = datetime.date.fromisoformat(day)

    class FixedDate(datetime.date):
        @classmethod
        def today(cls):
            return cls(when.year, when.month, when.day)

    scripts = os.path.join(checkout, "skills", "shared", "scripts")
    sys.path.insert(0, scripts)
    import vault_scaffold  # noqa: E402  (found through the path inserted above)

    vault_scaffold.datetime = types.SimpleNamespace(date=FixedDate)
    which = ["--no-system"] if system == "none" else ["--system", system]
    args = [vault, *which, f"--name={name}", "--write"]
    return vault_scaffold.main(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
