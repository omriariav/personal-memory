#!/usr/bin/env bash

# Shared safety helpers for migrate.sh and restore_backup.sh. This file is
# sourced by both entrypoints and intentionally has no side effects.

# User judgment that no rebuild can recreate, plus the active-slot pointer.
# Must stay in step with PRESERVED_SIDECARS in src/index-slots.ts — these are
# the only .index/ paths a backup archive may carry.
DURABLE_INDEX_STATE_FILES=(
  connector-state.json
  promotion-dismissals.json
  chain-dismissals.json
  slug-dismissals.json
  slug-proposals.json
  maintenance-state.json
  graph-maintenance.json
  active.json
)

migration_is_durable_index_path() {
  local candidate="$1" state_file
  [[ "$candidate" == ".index" ]] && return 0
  for state_file in "${DURABLE_INDEX_STATE_FILES[@]}"; do
    [[ "$candidate" == ".index/$state_file" ]] && return 0
  done
  return 1
}

migration_physical_dir() {
  (cd "$1" && pwd -P)
}

migration_external_dir() {
  local candidate="$1"
  local repo_root="$2"
  local label="$3"
  local resolved

  mkdir -p "$candidate"
  resolved="$(migration_physical_dir "$candidate")"
  case "$resolved" in
    "$repo_root"|"$repo_root"/*)
      die "$label must resolve outside the repository: $resolved"
      ;;
  esac
  printf '%s\n' "$resolved"
}

migration_validate_archive() {
  local archive_path="$1"
  local archive_listing archive_entry top_level
  local has_graph_store=0

  tar -tzf "$archive_path" >/dev/null

  while IFS= read -r archive_listing; do
    case "${archive_listing:0:1}" in
      -|d) ;;
      *) die "archive contains an unsupported entry type: $archive_listing" ;;
    esac
  done < <(tar -tvzf "$archive_path")

  while IFS= read -r archive_entry; do
    while [[ "$archive_entry" == ./* ]]; do
      archive_entry="${archive_entry#./}"
    done
    archive_entry="${archive_entry%/}"
    [[ -n "$archive_entry" ]] || continue

    [[ "$archive_entry" != /* ]] || die "archive contains an absolute path: $archive_entry"
    case "/$archive_entry/" in
      *"/../"*|*"/./"*) die "archive contains an unsafe path: $archive_entry" ;;
    esac

    top_level="${archive_entry%%/*}"
    case "$top_level" in
      memory|memory-public|memory-graphs)
        has_graph_store=1
        ;;
      .index)
        migration_is_durable_index_path "$archive_entry" || die "archive contains a non-durable .index path: $archive_entry"
        ;;
      *)
        die "archive contains an unexpected top-level path: $top_level"
        ;;
    esac
  done < <(tar -tzf "$archive_path")

  (( has_graph_store )) || die "archive contains no memory graph stores"
}

migration_create_archive() {
  local archive_path="$1"
  shift

  tar -czf "$archive_path" -- "$@"
  migration_validate_archive "$archive_path"
}
