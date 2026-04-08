#!/bin/bash

if [ "$#" -lt 3 ]; then
  echo "Usage: $0 \"<commit title>\" \"<commit body>\" <file> [file...]"
  exit 1
fi

title=$1
body=$2
shift 2

git add "$@"
git commit -m "$title" -m "$body"