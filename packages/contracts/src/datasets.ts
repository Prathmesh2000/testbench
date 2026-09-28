import { z } from 'zod';
import type { Result } from './domain';

// Data-driven testing: a project library of data sets (columns × rows, plus supporting files). A case
// linked to a data set runs once per row, and its steps can use {{column}} placeholders.

export const MAX_DATA_ROWS = 1000;

const column = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[\p{L}\p{N} _.-]+$/u, 'Column names use letters, digits, spaces, dots, hyphens and underscores');

export const DataSetBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000).default(''),
    columns: z.array(column).min(1).max(50),
    rows: z.array(z.record(z.string(), z.string().max(2000))).max(MAX_DATA_ROWS),
  })
  .refine((d) => new Set(d.columns.map((c) => c.toLowerCase())).size === d.columns.length, {
    message: 'Column names must be unique',
    path: ['columns'],
  });
export type DataSetBody = z.infer<typeof DataSetBody>;

export interface DataSetSummary {
  id: string;
  name: string;
  description: string;
  columns: string[];
  rowCount: number;
  caseCount: number;
  fileCount: number;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export interface DataFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  url: string;
  uploadedBy: string;
  createdAt: string;
}

export interface DataSetDetail extends DataSetSummary {
  rows: Record<string, string>[];
  files: DataFile[];
  cases: { key: string; title: string }[];
}

export const DataFileBody = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().min(1).max(120),
  sizeBytes: z
    .number()
    .int()
    .min(1)
    .max(100 * 1024 * 1024),
});

export const CaseDataSetBody = z.object({ dataSetId: z.uuid().nullable() });

/** The latest result of each data row of a case, per configuration, for the case's Data tab. */
export interface DataResults {
  dataSet: { id: string; name: string; columns: string[] } | null;
  rows: {
    index: number;
    values: Record<string, string>;
    results: { config: string; status: Result; runKey: string; at: string }[];
  }[];
}
