// Shell execution without execa dependency.
// Uses child_process directly for zero-dependency simplicity.

export interface ExecaResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failed: boolean;
}

export interface ExecaOptions {
  cwd: string;
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Execute a shell command and return structured results.
 *
 * Uses the system shell. For safety, dangerous commands should be
 * filtered at the tool permission layer.
 */
export async function execa(
  command: string,
  opts: ExecaOptions,
): Promise<ExecaResult> {
  const { exec } = await import("node:child_process");

  return new Promise((resolve, reject) => {
    const child = exec(command, {
      cwd: opts.cwd,
      timeout: opts.timeout,
      maxBuffer: 10 * 1024 * 1024, // 10MB
      signal: opts.signal,
      shell: process.platform === "win32" ? process.env["COMSPEC"] ?? "cmd.exe" : "/bin/sh",
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (data: string) => {
      stdout += data;
    });

    child.stderr?.on("data", (data: string) => {
      stderr += data;
    });

    child.on("close", (code: number | null) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0,
        failed: code !== 0,
      });
    });

    child.on("error", (err: Error) => {
      reject(err);
    });
  });
}
