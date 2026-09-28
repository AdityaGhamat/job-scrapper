import { describe, expect, it } from "vitest";
import {
  DEFINITION_PATH,
  loadDefinition,
} from "../src/scripts/create-search-index";

describe("create-search-index script", () => {
  it("resolves and loads the packaged search index definition", () => {
    // Regression test: the definition path must resolve inside ingest-api/,
    // not the repository root.
    expect(DEFINITION_PATH).toContain("ingest-api");
    expect(DEFINITION_PATH.endsWith("search-index/jobs-search-index.json")).toBe(true);

    const { name, definition } = loadDefinition();
    expect(name).toBe("jobs_search");
    const mappings = (definition as { mappings: { dynamic: boolean; fields: Record<string, unknown> } }).mappings;
    expect(mappings.dynamic).toBe(false);
    for (const field of ["company", "title", "location", "department", "source"]) {
      expect(mappings.fields[field], `missing mapping for ${field}`).toBeDefined();
    }
  });
});
