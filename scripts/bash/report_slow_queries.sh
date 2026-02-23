#!/bin/bash

ENGINE="${MYSQL_ENGINE:-}"
MYSQL_CMD="mysql -h127.0.0.1 -uroot"

echo "::group::Slow Query Report"
echo "Engine: ${ENGINE}"
echo "Configured long_query_time: 0.05s"

if [ "$ENGINE" != "Mysql" ] && [ "$ENGINE" != "Mariadb" ]; then
  echo "Skipping slow query report for engine: ${ENGINE}"
  echo "::endgroup::"
  exit 0
fi

if ! $MYSQL_CMD -e "SELECT @@version AS version, @@version_comment AS variant;"; then
  echo "Unable to connect to database for slow query report"
  echo "::endgroup::"
  exit 0
fi

SLOW_LOG_COUNT="$($MYSQL_CMD -N -s -e "SELECT COUNT(*) FROM mysql.slow_log;" 2>/dev/null)"
if [ -z "$SLOW_LOG_COUNT" ]; then
  echo "mysql.slow_log table not accessible; skipping report"
  echo "::endgroup::"
  exit 0
fi

if [ "$SLOW_LOG_COUNT" -eq 0 ]; then
  echo "No slow queries were logged"
  echo "::endgroup::"
  exit 0
fi

$MYSQL_CMD --table -e "
  SELECT
    ROUND(SUM(query_time_s), 6) AS total_time_s,
    COUNT(*) AS exec_count,
    ROUND(AVG(query_time_s), 6) AS avg_time_s,
    SUM(rows_examined) AS rows_examined,
    SUM(rows_sent) AS rows_sent,
    normalized_query AS sample_query
  FROM (
    SELECT
      TIME_TO_SEC(query_time) AS query_time_s,
      rows_examined,
      rows_sent,
      LEFT(REPLACE(REPLACE(TRIM(sql_text), '\n', ' '), '\t', ' '), 500) AS normalized_query
    FROM mysql.slow_log
    WHERE sql_text IS NOT NULL
      AND sql_text <> ''
  ) AS slow_query_rows
  GROUP BY normalized_query
  ORDER BY total_time_s DESC
  LIMIT 100;
" || echo "Failed to fetch slow query summary"

$MYSQL_CMD -e "SET GLOBAL slow_query_log = 'OFF';" >/dev/null 2>&1 || true

echo "::endgroup::"
exit 0
