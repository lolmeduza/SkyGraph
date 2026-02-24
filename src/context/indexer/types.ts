export interface FileIndexEntry {
  file: string;
  relativePath: string;
  pattern: string;
  domain: string;
  imports: string[];
  exports: string[];
  functions: string[];
  classes: string[];
  interfaces: string[];
  types: string[];
  hooks: string[];
  tags: string[];
  contentHash: string;
  metadata: {
    lines: number;
    complexity: number;
    lastModified: number;
  };
}

export interface IndexCache {
  version: string;
  timestamp: number;
  files: Record<string, FileIndexEntry>;
  metadata: {
    projectHash: string;
    lastScan: number;
    fileCount: number;
  };
}

export interface ScannedFile {
  path: string;
  relativePath: string;
  content: string;
  contentHash: string;
  lastModified: number;
}
