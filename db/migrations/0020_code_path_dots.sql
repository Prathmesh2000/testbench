-- Spec files are named like checkout.spec.ts; the first path rule refused any dot before the
-- extension. Segments still must start with a letter, digit, _ or -, so "." and ".." stay impossible.
ALTER TABLE studio.code_file DROP CONSTRAINT code_file_path_check;
ALTER TABLE studio.code_file ADD CONSTRAINT code_file_path_check
  CHECK (path ~ '^(pages|fixtures|utils|tests|data)(/[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*)+\.(ts|json)$');
