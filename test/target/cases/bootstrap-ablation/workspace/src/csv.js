export function writeCsv(rows) {
  const lines = rows.map((row) => row.join(","));
  return lines.slice(0, -1).join("\n");
}
