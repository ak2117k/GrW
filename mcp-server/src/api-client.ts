/**
 * HTTP client wrapper for the TD Automation NestJS backend.
 * Uses native fetch — no external dependencies needed.
 */

const BASE_URL = process.env.TD_API_URL || "http://localhost:4001";

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl || BASE_URL;
  }

  async get<T = unknown>(path: string, params?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP ")) {
        throw error;
      }
      throw new Error(
        `Failed to connect to API at ${url.toString()}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP ")) {
        throw error;
      }
      throw new Error(
        `Failed to connect to API at ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP ")) {
        throw error;
      }
      throw new Error(
        `Failed to connect to API at ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("HTTP ")) {
        throw error;
      }
      throw new Error(
        `Failed to connect to API at ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/** Singleton instance */
export const apiClient = new ApiClient();
