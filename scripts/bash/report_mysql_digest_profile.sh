#!/bin/bash

ENGINE="${MYSQL_ENGINE:-}"
MYSQL_CMD="mysql -h127.0.0.1 -uroot"
REPORT_PATH="${WORKSPACE:-$PWD}/tmp/mysql-digest-profile.csv"

echo "::group::MySQL Digest Profile"
echo "Engine: ${ENGINE}"

if [ "$ENGINE" != "Mysql" ]; then
  echo "Skipping digest profile for engine: ${ENGINE}"
  echo "::endgroup::"
  exit 0
fi

if ! $MYSQL_CMD -e "SELECT @@version AS version, @@version_comment AS variant;"; then
  echo "Unable to connect to database for digest profile"
  echo "::endgroup::"
  exit 0
fi

if ! $MYSQL_CMD -N -s -e "SELECT COUNT(*) FROM performance_schema.events_statements_summary_by_digest;" >/dev/null 2>&1; then
  echo "performance_schema digest table not accessible; skipping report"
  echo "::endgroup::"
  exit 0
fi

echo "Statement class totals (all statements):"
$MYSQL_CMD --table -e "
  SELECT
    stmt_class,
    ROUND(SUM_TIMER_WAIT_PS / 1000000000000, 6) AS total_time_s,
    ROUND((SUM_TIMER_WAIT_PS / NULLIF(total_ps.total_wait_ps, 0)) * 100, 2) AS pct_total_time,
    exec_count
  FROM (
    SELECT
      CASE
        WHEN LOWER(DIGEST_TEXT) LIKE 'select %' THEN 'SELECT'
        WHEN LOWER(DIGEST_TEXT) LIKE 'insert %' THEN 'INSERT'
        WHEN LOWER(DIGEST_TEXT) LIKE 'update %' THEN 'UPDATE'
        WHEN LOWER(DIGEST_TEXT) LIKE 'delete %' THEN 'DELETE'
        WHEN LOWER(DIGEST_TEXT) LIKE 'replace %' THEN 'REPLACE'
        WHEN LOWER(DIGEST_TEXT) LIKE 'truncate %' THEN 'TRUNCATE'
        WHEN LOWER(DIGEST_TEXT) LIKE 'alter %'
          OR LOWER(DIGEST_TEXT) LIKE 'create %'
          OR LOWER(DIGEST_TEXT) LIKE 'drop %'
          OR LOWER(DIGEST_TEXT) LIKE 'rename %' THEN 'DDL'
        ELSE 'OTHER'
      END AS stmt_class,
      SUM(SUM_TIMER_WAIT) AS SUM_TIMER_WAIT_PS,
      SUM(COUNT_STAR) AS exec_count
    FROM performance_schema.events_statements_summary_by_digest
    WHERE DIGEST_TEXT IS NOT NULL
      AND DIGEST_TEXT <> ''
    GROUP BY stmt_class
  ) classes
  CROSS JOIN (
    SELECT SUM(SUM_TIMER_WAIT) AS total_wait_ps
    FROM performance_schema.events_statements_summary_by_digest
    WHERE DIGEST_TEXT IS NOT NULL
      AND DIGEST_TEXT <> ''
  ) total_ps
  ORDER BY SUM_TIMER_WAIT_PS DESC;
" || echo "Failed to print statement-class totals"

echo
echo "Top DDL statements by total DB time:"
$MYSQL_CMD --table -e "
  SELECT
    ROUND(SUM_TIMER_WAIT / 1000000000000, 6) AS total_time_s,
    COUNT_STAR AS exec_count,
    ROUND(AVG_TIMER_WAIT / 1000000000000, 6) AS avg_time_s,
    LEFT(REPLACE(REPLACE(TRIM(DIGEST_TEXT), '\n', ' '), '\t', ' '), 500) AS sample_query
  FROM performance_schema.events_statements_summary_by_digest
  WHERE DIGEST_TEXT IS NOT NULL
    AND DIGEST_TEXT <> ''
    AND (
      LOWER(DIGEST_TEXT) LIKE 'alter %'
      OR LOWER(DIGEST_TEXT) LIKE 'create %'
      OR LOWER(DIGEST_TEXT) LIKE 'drop %'
      OR LOWER(DIGEST_TEXT) LIKE 'rename %'
      OR LOWER(DIGEST_TEXT) LIKE 'truncate %'
    )
  ORDER BY SUM_TIMER_WAIT DESC
  LIMIT 25;
" || echo "Failed to print top DDL by time"

echo
echo "Top DDL statements by execution count:"
$MYSQL_CMD --table -e "
  SELECT
    COUNT_STAR AS exec_count,
    ROUND(SUM_TIMER_WAIT / 1000000000000, 6) AS total_time_s,
    ROUND(AVG_TIMER_WAIT / 1000000000000, 6) AS avg_time_s,
    LEFT(REPLACE(REPLACE(TRIM(DIGEST_TEXT), '\n', ' '), '\t', ' '), 500) AS sample_query
  FROM performance_schema.events_statements_summary_by_digest
  WHERE DIGEST_TEXT IS NOT NULL
    AND DIGEST_TEXT <> ''
    AND (
      LOWER(DIGEST_TEXT) LIKE 'alter %'
      OR LOWER(DIGEST_TEXT) LIKE 'create %'
      OR LOWER(DIGEST_TEXT) LIKE 'drop %'
      OR LOWER(DIGEST_TEXT) LIKE 'rename %'
      OR LOWER(DIGEST_TEXT) LIKE 'truncate %'
    )
  ORDER BY COUNT_STAR DESC
  LIMIT 25;
" || echo "Failed to print top DDL by count"

echo
echo "Top 100 statements by total DB time (noise excluded):"
$MYSQL_CMD --table -e "
  SELECT
    ROUND(s.SUM_TIMER_WAIT / 1000000000000, 6) AS total_time_s,
    ROUND((s.SUM_TIMER_WAIT / NULLIF(t.total_wait, 0)) * 100, 2) AS pct_total_time,
    s.COUNT_STAR AS exec_count,
    ROUND(s.AVG_TIMER_WAIT / 1000000000000, 6) AS avg_time_s,
    s.SUM_ROWS_EXAMINED AS rows_examined,
    s.SUM_ROWS_SENT AS rows_sent,
    s.DIGEST AS digest,
    LEFT(REPLACE(REPLACE(TRIM(s.DIGEST_TEXT), '\n', ' '), '\t', ' '), 500) AS sample_query
  FROM performance_schema.events_statements_summary_by_digest s
  JOIN (
    SELECT SUM(SUM_TIMER_WAIT) AS total_wait
    FROM performance_schema.events_statements_summary_by_digest
    WHERE DIGEST_TEXT IS NOT NULL
      AND DIGEST_TEXT <> ''
      AND LOWER(DIGEST_TEXT) NOT LIKE 'select get_lock(%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'select release_lock(%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'drop database%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'drop schema%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'set global %'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'set session %'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'show variables%'
  ) t
  WHERE s.DIGEST_TEXT IS NOT NULL
    AND s.DIGEST_TEXT <> ''
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'select get_lock(%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'select release_lock(%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'drop database%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'drop schema%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'set global %'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'set session %'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'show variables%'
  ORDER BY s.SUM_TIMER_WAIT DESC
  LIMIT 100;
" || echo "Failed to print digest profile"

echo
echo "Excluded maintenance/lock noise:"
$MYSQL_CMD --table -e "
  SELECT
    reason,
    ROUND(SUM(sum_timer_wait) / 1000000000000, 6) AS total_time_s,
    SUM(count_star) AS exec_count
  FROM (
    SELECT
      CASE
        WHEN LOWER(DIGEST_TEXT) LIKE 'select get_lock(%' OR LOWER(DIGEST_TEXT) LIKE 'select release_lock(%' THEN 'LOCK_FUNCTIONS'
        WHEN LOWER(DIGEST_TEXT) LIKE 'drop database%' THEN 'DROP_DATABASE'
        WHEN LOWER(DIGEST_TEXT) LIKE 'drop schema%' THEN 'DROP_SCHEMA'
        WHEN LOWER(DIGEST_TEXT) LIKE 'set global %' OR LOWER(DIGEST_TEXT) LIKE 'set session %' THEN 'SET_STATEMENTS'
        WHEN LOWER(DIGEST_TEXT) LIKE 'show variables%' THEN 'SHOW_VARIABLES'
        ELSE 'OTHER'
      END AS reason,
      SUM_TIMER_WAIT AS sum_timer_wait,
      COUNT_STAR AS count_star
    FROM performance_schema.events_statements_summary_by_digest
    WHERE DIGEST_TEXT IS NOT NULL
      AND DIGEST_TEXT <> ''
  ) categorized
  WHERE reason <> 'OTHER'
  GROUP BY reason
  ORDER BY total_time_s DESC;
" || echo "Failed to print excluded-noise summary"

mkdir -p "$(dirname "$REPORT_PATH")"
$MYSQL_CMD -N -B -e "
  SELECT
    CONCAT_WS(',',
      @@version,
      QUOTE(s.DIGEST),
      ROUND(s.SUM_TIMER_WAIT / 1000000000000, 6),
      ROUND((s.SUM_TIMER_WAIT / NULLIF(t.total_wait, 0)) * 100, 2),
      s.COUNT_STAR,
      ROUND(s.AVG_TIMER_WAIT / 1000000000000, 6),
      s.SUM_ROWS_EXAMINED,
      s.SUM_ROWS_SENT,
      QUOTE(LEFT(REPLACE(REPLACE(TRIM(s.DIGEST_TEXT), '\n', ' '), '\t', ' '), 500))
    )
  FROM performance_schema.events_statements_summary_by_digest s
  JOIN (
    SELECT SUM(SUM_TIMER_WAIT) AS total_wait
    FROM performance_schema.events_statements_summary_by_digest
    WHERE DIGEST_TEXT IS NOT NULL
      AND DIGEST_TEXT <> ''
      AND LOWER(DIGEST_TEXT) NOT LIKE 'select get_lock(%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'select release_lock(%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'drop database%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'drop schema%'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'set global %'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'set session %'
      AND LOWER(DIGEST_TEXT) NOT LIKE 'show variables%'
  ) t
  WHERE s.DIGEST_TEXT IS NOT NULL
    AND s.DIGEST_TEXT <> ''
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'select get_lock(%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'select release_lock(%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'drop database%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'drop schema%'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'set global %'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'set session %'
    AND LOWER(s.DIGEST_TEXT) NOT LIKE 'show variables%'
  ORDER BY s.SUM_TIMER_WAIT DESC
  LIMIT 100;
" > "$REPORT_PATH"

if [ -s "$REPORT_PATH" ]; then
  sed -i '1i version,digest,total_time_s,pct_total_time,exec_count,avg_time_s,rows_examined,rows_sent,digest_text' "$REPORT_PATH"
  echo "Digest profile CSV: $REPORT_PATH"
else
  echo "No digest rows written to CSV"
fi

echo "::endgroup::"
exit 0
