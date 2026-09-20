import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";


if (!process.argv[2] || !process.argv[3]) {
  throw new Error("Usage: extract-review-csv.mjs WORKBOOK NEW_CSV_PATH");
}
const workbookPath = path.resolve(process.argv[2]);
const outputPath = path.resolve(process.argv[3]);
if (workbookPath === outputPath) {
  throw new Error("Input workbook and output CSV paths must differ");
}
try {
  await fs.lstat(outputPath);
  throw new Error("Output already exists; choose a new CSV filename: " + outputPath);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const expectedHeader = [
  "query_id",
  "split",
  "query",
  "decision",
  "reason",
  "reviewer",
  "title",
  "summary",
  "target_description",
  "regions",
  "categories",
  "application_period",
  "organization",
  "program_id",
];

const input = await FileBlob.load(workbookPath);
const workbook = await SpreadsheetFile.importXlsx(input);
const sheet = workbook.worksheets.getItem("검토표");
const values = sheet.getUsedRange(true).values;
if (sheet.getUsedRange(true).formulas.some((row) => row.some((value) => value))) {
  throw new Error("Review cells must contain literal text, not formulas");
}
if (!Array.isArray(values) || values.length < 2) {
  throw new Error("The review workbook has no data rows");
}
const header = values[0].map((value) => String(value ?? ""));
if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
  throw new Error("The review workbook columns or column order changed");
}
if (values.some((row) => row.length !== expectedHeader.length)) {
  throw new Error("The review workbook contains an invalid row width");
}

function escapeCsv(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

const csv = `\uFEFF${values.map((row) => row.map(escapeCsv).join(",")).join("\r\n")}\r\n`;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, csv, { encoding: "utf8", flag: "wx" });
console.log(JSON.stringify({ outputPath, rowCount: values.length - 1 }, null, 2));
