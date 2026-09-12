#!/bin/sh
# Syntax-check every JavaScript file in the project.
set -e
fail=0
for f in $(find src migrations scripts test -name '*.mjs' -o -name '*.js' 2>/dev/null | sort); do
  if ! node --check "$f" 2>/tmp/meridian-check.err; then
    echo "FAIL $f"; sed -n '1,6p' /tmp/meridian-check.err; fail=1
  fi
done
[ $fail -eq 0 ] && echo "syntax OK — $(find src -name '*.mjs' -o -name '*.js' | wc -l | tr -d ' ') files"
exit $fail
