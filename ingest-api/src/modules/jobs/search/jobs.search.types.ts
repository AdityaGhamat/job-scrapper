import type { JobSource } from "../jobs.types";

export const SEARCH_SORTS = ["relevance", "updated", "company", "title"] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

export const MAX_SEARCH_LIMIT = 50;
export const MAX_SUGGESTIONS_LIMIT = 10;

export interface ParsedSearchQuery {
  q?: string;
  sources: JobSource[];
  companies: string[];
  locations: string[];
  departments: string[];
  page: number;
  limit: number;
  sort: SearchSort;
  skip: number;
}

export interface SearchResultItem {
  id: string;
  company: string;
  title: string;
  location: string;
  department: string | null;
  url: string;
  updated: string | null;
  source: JobSource;
  /** Present only when q was provided and the backend returned a real score. */
  score?: number;
}

export interface SearchPagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
}

export interface SearchResponseBody {
  success: true;
  data: SearchResultItem[];
  pagination: SearchPagination;
}

export type SuggestionType = "title" | "company" | "location";

export interface SuggestionItem {
  type: SuggestionType;
  value: string;
}

export interface ParsedSuggestionsQuery {
  q: string;
  limit: number;
}

export interface SuggestionsResponseBody {
  success: true;
  suggestions: SuggestionItem[];
}
