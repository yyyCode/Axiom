import { z } from "zod";
import { defineTool } from "../registry.js";

// ─── Web Search ───────────────────────────────────────────────────

export const webSearchTool = defineTool(
  {
    name: "web_search",
    description:
      "Search the web and return result blocks with titles and URLs. Use for accessing information beyond your knowledge cutoff.",
    isMutating: false,
    riskLevel: "readonly",
  },
  {
    query: z.string().describe("The search query to use"),
    allowed_domains: z.array(z.string()).optional().describe(
      "Only include search results from these domains",
    ),
    blocked_domains: z.array(z.string()).optional().describe(
      "Never include search results from these domains",
    ),
  },
  async (input, _ctx) => {
    // Placeholder: in production, integrate a real search API
    // (Brave, Tavily, Google Custom Search, etc.)
    return {
      content: `Web search is not yet configured. Query: "${input.query}"\nIntegrate a search API (Brave, Tavily, etc.) to enable this tool.`,
      isError: true,
    };
  },
);

// ─── Web Fetch ────────────────────────────────────────────────────

export const webFetchTool = defineTool(
  {
    name: "web_fetch",
    description:
      "Fetches a URL, converts the page to markdown, and processes it. Useful for reading documentation and web content.",
    isMutating: false,
    riskLevel: "readonly",
  },
  {
    url: z.string().describe("The URL to fetch content from"),
    prompt: z.string().optional().describe(
      "Optional prompt to run against the fetched content",
    ),
  },
  async (input, _ctx) => {
    try {
      const url = new URL(input.url);
      const response = await fetch(url.toString(), {
        headers: { "User-Agent": "Axiom-Agent/1.0" },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        return {
          content: `HTTP ${response.status}: Failed to fetch ${input.url}`,
          isError: true,
        };
      }

      const html = await response.text();
      // Simple HTML to markdown conversion (production: use turndown or similar)
      const markdown = htmlToMarkdown(html);

      const truncated = markdown.length > 50000
        ? markdown.slice(0, 50000) + `\n\n... (truncated ${markdown.length - 50000} chars)`
        : markdown;

      return {
        content: truncated,
        data: { url: input.url, length: markdown.length },
      };
    } catch (err) {
      return {
        content: `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
);

// Simple HTML-to-markdown conversion
function htmlToMarkdown(html: string): string {
  // Strip scripts and styles
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  // Basic conversions
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/h[1-6]>/gi, "\n\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<\/tr>/gi, "\n");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Decode entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  // Collapse whitespace
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");

  return text.trim();
}

export const webTools = [webSearchTool, webFetchTool];
