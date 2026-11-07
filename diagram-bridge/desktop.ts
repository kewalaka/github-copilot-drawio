import { execFile, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
async function launch(command: string, args: string[], wait: boolean) {
  if (wait) {
    await execute(command, args, { timeout: 5000 });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function findExecutable(name: string) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const file = join(directory, name);
    try {
      accessSync(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

export async function openDesktop(filename: string, { platform = process.platform, find = findExecutable, start = launch } = {}) {
  let command: string | null = null;
  let args = [filename];
  if (platform === 'darwin') {
    command = 'open';
    args = ['-b', 'com.jgraph.drawio.desktop', filename];
  } else if (platform === 'linux') command = find('drawio');
  else if (platform === 'win32') {
    command = find('draw.io.exe') ?? [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/draw.io/draw.io.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'draw.io/draw.io.exe'),
    ].find((path): path is string => !!path && existsSync(path)) ?? null;
  }
  if (!command) return false;
  try {
    await start(command, args, platform === 'darwin');
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT' || (platform === 'darwin' && error.code === 1 && /Unable to find application/i.test(error.stderr ?? ''))) return false;
    throw new Error('Could not launch draw.io desktop. Check application permissions, then resume here or try again.');
  }
}
